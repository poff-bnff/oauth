/**
 * appointmentsForLogin — what GET /api/my/appointments answers: the appointments Fiona holds NOW for the logged-in user's accounts
 * (XAPI account routes: no publish step, and no Strapi person needed - the MyPoff account id is enough), and the published-card
 * path (`fallback`) whenever Fiona has no account for any of them or a read fails. 2026-11-12: a login whose Strapi user had no
 * person (Laura) could not be matched by the published-card path at all and saw nothing, although Fiona held her appointment.
 */
import { describe, it, expect, vi } from 'vitest'
import { appointmentsForLogin } from '../server/utils/fiona/loginLiveAppointments.js'
import { createLoaderCache } from '../server/utils/fiona/loaderCache.js'

const GB = 'gb-1'
const badRequest = () => Object.assign(new Error('[GET] "…": 400 Bad Request'), { statusCode: 400 })
const apptPath = id => `/account/MyPoff/${id}/guestbook/${GB}/appointments?includeAttendees=true`
const progPath = id => `/account/MyPoff/${id}/guestbook/${GB}/meetingprogramparticipations`

const answer = (appointments, accreditationId = 'acc-1') => ({ Accreditation: { Id: accreditationId, Description: 'Laura Jaakson' }, Appointments: appointments })
const party = { Id: 'ap-party', AppointmentType: { Description: 'Party' }, StartsOn: '2026-11-13T06:30:00+00:00', EndsOn: '2026-11-13T06:45:00+00:00', Subject: 'TEST - Party', Location: { Description: 'Iglupark' }, Members: [{ FullName: 'Laura Jaakson', Role: { Key: 'film-maker', Translations: [{ Language: 'en', Text: 'Film maker' }] } }, { FullName: 'Jaan Leppik', Role: null }] }
const participations = { Schedules: [{ Name: 'One-on-one meetings 2026', MeetingPrograms: [{ Id: 'mp-1', Name: 'Film Market' }] }] }

function fakeXapi (routes) {
  const asked = []
  return {
    asked,
    getRaw: (path) => {
      asked.push(path)
      const route = routes[path]
      if (route === undefined) return Promise.reject(badRequest())
      return route instanceof Error ? Promise.reject(route) : Promise.resolve(route)
    }
  }
}

function setup (overrides = {}) {
  const fallbackAnswer = { ok: true, programmes: [], appointments: [{ id: 'from-card' }] }
  return {
    user: { id: 17745, aliasUsers: [] },
    xapi: fakeXapi({ [apptPath(17745)]: answer([party]), [progPath(17745)]: participations }),
    strapi: { getActiveGuestbookIds: () => Promise.resolve([GB]) },
    lang: 'en',
    readCardProgrammes: () => Promise.resolve([]),
    fallback: vi.fn(() => Promise.resolve(fallbackAnswer)),
    cache: createLoaderCache({ ttlMs: 60 * 1000 }),
    log: { warn: vi.fn() },
    fallbackAnswer,
    ...overrides
  }
}

describe('appointmentsForLogin', () => {
  it('answers from Fiona now for a user that has no Strapi person at all, in the shape the page knows, without profile links', async () => {
    const deps = setup()

    const result = await appointmentsForLogin(deps)

    expect(result).toEqual({
      ok: true,
      source: 'live',
      programmes: [expect.objectContaining({ id: 'mp-1', name: 'Film Market', schedule: 'One-on-one meetings 2026', role: null })],
      appointments: [{
        id: 'ap-party',
        type: { key: 'party', text: 'Party', abbreviation: null },
        startsOn: '2026-11-13T06:30:00.000Z',
        endsOn: '2026-11-13T06:45:00.000Z',
        subject: 'TEST - Party',
        location: 'Iglupark',
        isOnline: false,
        table: null,
        notes: null,
        members: [
          { name: 'Laura Jaakson', role: { key: 'film-maker', text: 'Film maker' }, isMe: true, slug: null },
          { name: 'Jaan Leppik', role: null, isMe: false, slug: null }
        ]
      }]
    })
    expect(deps.fallback).not.toHaveBeenCalled()
  })

  it('reads every account of the login: the main user and its aliases', async () => {
    const deps = setup({ user: { id: 5, aliasUsers: [{ id: 6 }, { id: 7 }] }, xapi: fakeXapi({ [apptPath(6)]: answer([party]) }) })

    const result = await appointmentsForLogin(deps)

    expect(result.source).toBe('live')
    expect(deps.xapi.asked.filter(path => path.endsWith('/appointments?includeAttendees=true')).sort()).toEqual([apptPath(5), apptPath(6), apptPath(7)])
  })

  it('takes the role in each programme from the published card when it names the same programme', async () => {
    const deps = setup({ readCardProgrammes: vi.fn(() => Promise.resolve([{ id: 'mp-1', name: 'Film Market', role: { key: 'industry-representative', text: 'Industry representative' } }])) })

    const result = await appointmentsForLogin(deps)

    expect(deps.readCardProgrammes).toHaveBeenCalledWith(['acc-1'])
    expect(result.programmes[0].role).toEqual({ key: 'industry-representative', text: 'Industry representative' })
  })

  it('still answers live, with no programme roles, when the published card cannot be read', async () => {
    const deps = setup({ readCardProgrammes: () => Promise.reject(new Error('Fiona publication is down')) })

    const result = await appointmentsForLogin(deps)

    expect(result.source).toBe('live')
    expect(result.programmes[0].role).toBeNull()
  })

  it('falls back to the published-card path when Fiona has no account under any of the ids', async () => {
    const deps = setup({ xapi: fakeXapi({}) })

    expect(await appointmentsForLogin(deps)).toBe(deps.fallbackAnswer)
    expect(deps.fallback).toHaveBeenCalledTimes(1)
  })

  it('falls back when a read fails for another reason, and says so in the log without any name or id', async () => {
    const deps = setup({ xapi: fakeXapi({ [apptPath(17745)]: Object.assign(new Error('504 Gateway Time-out'), { statusCode: 504 }) }) })

    expect(await appointmentsForLogin(deps)).toBe(deps.fallbackAnswer)
    expect(deps.log.warn).toHaveBeenCalledTimes(1)
    expect(String(deps.log.warn.mock.calls[0][0])).toContain('504')
    expect(String(deps.log.warn.mock.calls[0][0])).not.toContain('17745')
  })

  it('falls back when the active guestbooks cannot be read, when there are none, or when no XAPI client is configured', async () => {
    const broken = setup({ strapi: { getActiveGuestbookIds: () => Promise.reject(new Error('Strapi 504')) } })
    const none = setup({ strapi: { getActiveGuestbookIds: () => Promise.resolve([]) } })
    const unconfigured = setup({ xapi: null })

    for (const deps of [broken, none, unconfigured]) expect(await appointmentsForLogin(deps)).toBe(deps.fallbackAnswer)
  })

  it('falls back for a user without any id', async () => {
    const deps = setup({ user: {} })

    expect(await appointmentsForLogin(deps)).toBe(deps.fallbackAnswer)
  })

  it('answers an empty live list as an empty list, not as a reason to fall back', async () => {
    const deps = setup({ xapi: fakeXapi({ [apptPath(17745)]: answer([]), [progPath(17745)]: { Schedules: [] } }) })

    expect(await appointmentsForLogin(deps)).toEqual({ ok: true, source: 'live', programmes: [], appointments: [] })
    expect(deps.fallback).not.toHaveBeenCalled()
  })

  it('reads Fiona once a minute per login, not at every page view, and keeps languages and logins apart', async () => {
    const deps = setup()

    await appointmentsForLogin(deps)
    await appointmentsForLogin(deps)
    const reads = deps.xapi.asked.length
    await appointmentsForLogin({ ...deps, lang: 'et' })
    await appointmentsForLogin({ ...deps, user: { id: 99, aliasUsers: [] } })

    expect(reads).toBe(2)
    expect(deps.xapi.asked.length).toBeGreaterThan(reads)
  })
})
