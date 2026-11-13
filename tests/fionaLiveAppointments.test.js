/**
 * readLiveAppointments — reads what Fiona holds NOW for a login (no publish step): for every account of the login (main +
 * aliases) and every active guestbook, the XAPI appointments and meeting programme participations, merged. A 404 only
 * means "Fiona has no account under that id"; any other failure makes the answer "not ok" so the caller can fall back to the
 * published card instead of showing a half answer as complete.
 */
import { describe, it, expect } from 'vitest'
import { readLiveAppointments } from '../server/utils/fiona/liveAppointments.js'

const GB = 'gb-1'
const notFound = () => Object.assign(new Error('[GET] "…": 404 Not Found'), { statusCode: 404 })
const badRequest = () => Object.assign(new Error('[GET] "…": 400 Bad Request'), { statusCode: 400 })

const accountAnswer = (accreditationId, name, appointments) => ({
  Accreditation: { Id: accreditationId, Description: name },
  AccreditationStatus: { Key: 'guest' },
  Appointments: appointments
})
const appt = (id, startsOn, members = []) => ({ Id: id, AppointmentType: { Description: 'Interview' }, StartsOn: startsOn, EndsOn: startsOn, Subject: id, Members: members })
const participations = { Schedules: [{ Name: 'One-on-one meetings 2026', MeetingPrograms: [{ Id: 'mp-1', Name: 'Film Market' }] }] }

// a fake XAPI: routes are path → answer or error; every path asked is recorded
function fakeXapi (routes) {
  const asked = []
  return {
    asked,
    getRaw: (path) => {
      asked.push(path)
      const route = routes[path]
      if (route === undefined) return Promise.reject(notFound())
      return route instanceof Error ? Promise.reject(route) : Promise.resolve(route)
    }
  }
}

const apptPath = id => `/account/MyPoff/${id}/guestbook/${GB}/appointments?includeAttendees=true`
const progPath = id => `/account/MyPoff/${id}/guestbook/${GB}/meetingprogramparticipations`

describe('readLiveAppointments', () => {
  it('reads the appointments and the programme participations of an account in a guestbook', async () => {
    const xapi = fakeXapi({
      [apptPath(22135)]: accountAnswer('acc-1', 'Jaan Leppik', [appt('b', '2026-11-13T06:00:00Z'), appt('a', '2026-11-12T06:00:00Z')]),
      [progPath(22135)]: participations
    })

    const result = await readLiveAppointments({ xapi, userIds: [22135], guestbookIds: [GB] })

    expect(result).toMatchObject({ ok: true, found: true, accreditationIds: ['acc-1'], errors: [] })
    expect(result.appointments.map(item => item.id)).toEqual(['a', 'b'])
    expect(result.programmes).toEqual([expect.objectContaining({ id: 'mp-1', name: 'Film Market', schedule: 'One-on-one meetings 2026' })])
    expect(xapi.asked.sort()).toEqual([apptPath(22135), progPath(22135)].sort())
  })

  it('merges the accounts of a login, drops an appointment two of them both show, and ignores an account Fiona does not know', async () => {
    const xapi = fakeXapi({
      [apptPath(6)]: accountAnswer('acc-1', 'Jaan Leppik', [appt('a', '2026-11-12T06:00:00Z'), appt('shared', '2026-11-13T06:00:00Z')]),
      [apptPath(7)]: accountAnswer('acc-1', 'Jaan Leppik', [appt('shared', '2026-11-13T06:00:00Z'), appt('c', '2026-11-14T06:00:00Z')]),
      [progPath(7)]: participations
    })

    const result = await readLiveAppointments({ xapi, userIds: [5, 6, 7], guestbookIds: [GB] })

    expect(result).toMatchObject({ ok: true, found: true, accreditationIds: ['acc-1'], unknownAccounts: 1 })
    expect(result.appointments.map(item => item.id)).toEqual(['a', 'shared', 'c'])
    expect(result.programmes).toHaveLength(1)
  })

  it('says "not found", but still "ok", when Fiona has no account under any of the ids', async () => {
    const result = await readLiveAppointments({ xapi: fakeXapi({}), userIds: [5, 6], guestbookIds: [GB] })

    expect(result).toMatchObject({ ok: true, found: false, accreditationIds: [], appointments: [], programmes: [], errors: [], unknownAccounts: 2 })
  })

  it('is not ok when a read fails for another reason, and keeps what the other reads gave', async () => {
    const xapi = fakeXapi({
      [apptPath(5)]: accountAnswer('acc-1', 'Jaan Leppik', [appt('a', '2026-11-12T06:00:00Z')]),
      [progPath(5)]: new Error('504 Gateway Time-out'),
      [apptPath(6)]: Object.assign(new Error('500 Internal'), { statusCode: 500 })
    })

    const result = await readLiveAppointments({ xapi, userIds: [5, 6], guestbookIds: [GB] })

    expect(result.ok).toBe(false)
    expect(result.found).toBe(true)
    expect(result.appointments.map(item => item.id)).toEqual(['a'])
    expect(result.errors).toEqual([{ what: 'meetingprogramparticipations', error: '504 Gateway Time-out' }, { what: 'appointments', error: '500 Internal' }])
  })

  it('reads every active guestbook', async () => {
    const xapi = fakeXapi({
      [apptPath(5)]: accountAnswer('acc-1', 'Jaan Leppik', [appt('a', '2026-11-12T06:00:00Z')]),
      '/account/MyPoff/5/guestbook/gb-2/appointments?includeAttendees=true': accountAnswer('acc-2', 'Jaan Leppik', [appt('z', '2026-11-20T06:00:00Z')])
    })

    const result = await readLiveAppointments({ xapi, userIds: [5], guestbookIds: [GB, 'gb-2'] })

    expect(result.accreditationIds).toEqual(['acc-1', 'acc-2'])
    expect(result.appointments.map(item => item.id)).toEqual(['a', 'z'])
  })

  it('asks for nothing when there is no id or no guestbook, and skips blank ids', async () => {
    const xapi = fakeXapi({})

    expect(await readLiveAppointments({ xapi, userIds: [], guestbookIds: [GB] })).toMatchObject({ ok: true, found: false })
    expect(await readLiveAppointments({ xapi, userIds: [5], guestbookIds: [] })).toMatchObject({ ok: true, found: false })
    await readLiveAppointments({ xapi, userIds: [null, '', undefined, 0], guestbookIds: [GB] })

    expect(xapi.asked).toEqual([])
  })

  it('passes the programme roles of the published card on, so the programme chip can say "as Industry representative"', async () => {
    const xapi = fakeXapi({ [apptPath(5)]: accountAnswer('acc-1', 'Jaan Leppik', []), [progPath(5)]: participations })
    const publishedProgrammes = [{ id: 'mp-1', role: { key: 'industry-representative', text: 'Industry representative' } }]

    const result = await readLiveAppointments({ xapi, userIds: [5], guestbookIds: [GB], publishedProgrammes })

    expect(result.programmes[0].role).toEqual({ key: 'industry-representative', text: 'Industry representative' })
  })

  it('encodes the ids it puts in a path', async () => {
    const xapi = fakeXapi({})

    await readLiveAppointments({ xapi, userIds: ['a/b'], guestbookIds: ['g b'] })

    expect(xapi.asked).toContain('/account/MyPoff/a%2Fb/guestbook/g%20b/appointments?includeAttendees=true')
  })

  it('treats a 400 like a 404: Fiona answers 400 for an id it has no account under', async () => {
    const xapi = {
      asked: [],
      getRaw (path) {
        this.asked.push(path)
        if (path === apptPath(7)) return Promise.resolve(accountAnswer('acc-1', 'Jaan Leppik', [appt('a', '2026-11-12T06:00:00Z')]))
        return Promise.reject(path.includes('/account/MyPoff/7/') ? notFound() : badRequest())
      }
    }

    const result = await readLiveAppointments({ xapi, userIds: [5, 6, 7], guestbookIds: [GB] })

    expect(result).toMatchObject({ ok: true, found: true, errors: [], unknownAccounts: 2 })
    expect(result.appointments.map(item => item.id)).toEqual(['a'])
  })

  it('does not call an account unknown when one of its reads failed for another reason', async () => {
    const xapi = fakeXapi({ [apptPath(5)]: Object.assign(new Error('500 Internal'), { statusCode: 500 }) })

    const result = await readLiveAppointments({ xapi, userIds: [5], guestbookIds: [GB] })

    expect(result).toMatchObject({ ok: false, unknownAccounts: 0 })
  })

  it('says how long each Fiona call took and how it ended, without any id', async () => {
    const xapi = {
      getRaw: (path) => {
        if (path.includes('/account/MyPoff/6/')) return Promise.reject(badRequest())
        return Promise.resolve(path.endsWith('/appointments?includeAttendees=true') ? accountAnswer('acc-1', 'Jaan Leppik', []) : participations)
      }
    }
    const clockTicks = [0, 0, 200, 200, 200, 400, 2200, 2200, 2200, 4000]
    let tick = 0
    const now = () => clockTicks[Math.min(tick++, clockTicks.length - 1)]

    const result = await readLiveAppointments({ xapi, userIds: [5, 6], guestbookIds: [GB], now })

    expect(result.calls).toHaveLength(4)
    expect(result.calls.map(call => call.what).sort()).toEqual(['appointments', 'appointments', 'meetingprogramparticipations', 'meetingprogramparticipations'])
    expect(result.calls.every(call => ['ok', 'no account'].includes(call.outcome) && Number.isFinite(call.ms))).toBe(true)
    expect(result.calls.filter(call => call.outcome === 'no account')).toHaveLength(2)
    expect(result.calls.every(call => Object.keys(call).sort().join() === 'ms,outcome,what')).toBe(true)
  })
})
