/**
 * liveAppointmentsReport — read-only probe (mode `liveAppointments` with `userIds`): for a few logins, what Fiona holds now (XAPI)
 * against what the published card says, appointment by appointment, with the time each read took. Names and e-mails of the
 * login are not in the answer; the two values of a differing field only when showValues is set.
 */
import { describe, it, expect } from 'vitest'
import { liveAppointmentsReport } from '../server/utils/fiona/liveAppointmentsReport.js'

const GB = 'gb-1'
const member = (name, roleText = null) => ({ id: null, name, role: roleText ? { key: roleText.toLowerCase(), text: roleText } : null, personId: null, isMe: false })
const published = (id, overrides = {}) => ({
  id,
  type: { key: 'interview', text: 'Interview', abbreviation: null },
  startsOn: '2026-11-12T06:00:00.000Z',
  endsOn: '2026-11-12T06:15:00.000Z',
  subject: `TEST ${id}`,
  location: 'Cuba Films office',
  isOnline: false,
  table: null,
  notes: null,
  members: [member('Jaan Leppik')],
  ...overrides
})
const liveRaw = (id, overrides = {}) => ({
  Id: id,
  AppointmentType: { Description: 'Interview' },
  StartsOn: '2026-11-12T06:00:00+00:00',
  EndsOn: '2026-11-12T06:15:00+00:00',
  Subject: `TEST ${id}`,
  Location: { Description: 'Cuba Films office' },
  Members: [{ FullName: 'Jaan Leppik', Role: null }],
  ...overrides
})

const user = { id: 5, email: 'jaan@example.ee', person: { id: 77, firstName: 'Jaan', lastName: 'Leppik' }, aliasUsers: [{ id: 6, email: 'alias@example.ee' }] }

function clock () { let t = 0; return () => { t += 25; return t } }

function setup ({ routes = {}, publishedAnswer = { ok: true, programmes: [], appointments: [] }, users = { 5: user } } = {}) {
  return {
    loadUser: id => Promise.resolve(users[id] ?? null),
    loadPerson: id => Promise.resolve({ id, first_name: 'Jaan', lastName: 'Leppik' }),
    xapi: { getRaw: path => (routes[path] instanceof Error ? Promise.reject(routes[path]) : routes[path] ? Promise.resolve(routes[path]) : Promise.reject(Object.assign(new Error('Not Found'), { statusCode: 404 }))) },
    strapi: { getActiveGuestbookIds: () => Promise.resolve([GB]) },
    readPublished: () => Promise.resolve(publishedAnswer),
    now: clock()
  }
}

const accountPath = id => `/account/MyPoff/${id}/guestbook/${GB}/appointments?includeAttendees=true`

describe('liveAppointmentsReport', () => {
  it('reads the accounts of the login, compares live with published and says how long each read took', async () => {
    const deps = setup({
      routes: { [accountPath(6)]: { Accreditation: { Id: 'acc-1', Description: 'Jaan Leppik' }, Appointments: [liveRaw('a'), liveRaw('b', { Subject: 'TEST changed' })] } },
      publishedAnswer: { ok: true, programmes: [], appointments: [published('a'), published('b'), published('gone')] }
    })

    const { users } = await liveAppointmentsReport({ userIds: [5], ...deps })

    expect(users).toEqual([{
      userId: 5,
      accounts: 2,
      guestbooks: 1,
      live: { ok: true, found: true, accreditations: 1, appointments: 2, programmes: [], errors: [], ms: 25 },
      published: { ok: true, appointments: 3, programmes: [], ms: 25 },
      comparison: { live: 2, published: 3, same: 1, onlyInLive: [], onlyInPublished: ['gone'], different: [{ id: 'b', fields: ['subject'] }] }
    }])
  })

  it('shows the two values of a differing field only when asked', async () => {
    const deps = setup({
      routes: { [accountPath(5)]: { Accreditation: { Id: 'acc-1', Description: 'Jaan Leppik' }, Appointments: [liveRaw('b', { Subject: 'TEST changed' })] } },
      publishedAnswer: { ok: true, programmes: [], appointments: [published('b')] }
    })

    const hidden = await liveAppointmentsReport({ userIds: [5], ...deps })
    const shown = await liveAppointmentsReport({ userIds: [5], showValues: true, ...deps })

    expect(hidden.users[0].comparison.different[0].values).toBeUndefined()
    expect(shown.users[0].comparison.different[0].values).toEqual({ subject: { live: 'TEST changed', published: 'TEST b' } })
  })

  it('reports the programmes of both sides by name and role', async () => {
    const programme = { id: 'mp-1', name: 'Film Market', schedule: 'S', role: { key: 'ir', text: 'Industry representative' } }
    const deps = setup({
      routes: {
        [accountPath(5)]: { Accreditation: { Id: 'acc-1', Description: 'Jaan Leppik' }, Appointments: [] },
        [`/account/MyPoff/5/guestbook/${GB}/meetingprogramparticipations`]: { Schedules: [{ Name: 'S', MeetingPrograms: [{ Id: 'mp-1', Name: 'Film Market' }] }] }
      },
      publishedAnswer: { ok: true, programmes: [programme], appointments: [] }
    })

    const { users } = await liveAppointmentsReport({ userIds: [5], ...deps })

    expect(users[0].live.programmes).toEqual([{ name: 'Film Market', role: 'Industry representative' }])
    expect(users[0].published.programmes).toEqual([{ name: 'Film Market', role: 'Industry representative' }])
  })

  it('says why there is no comparison when the live read failed', async () => {
    const deps = setup({ routes: { [accountPath(5)]: new Error('504 Gateway Time-out') } })

    const { users } = await liveAppointmentsReport({ userIds: [5], ...deps })

    expect(users[0].live).toMatchObject({ ok: false, found: false, errors: [{ what: 'appointments', error: '504 Gateway Time-out' }] })
    expect(users[0].comparison).toBeNull()
  })

  it('does not fail when the published side cannot be read', async () => {
    const deps = setup({ routes: { [accountPath(5)]: { Accreditation: { Id: 'acc-1', Description: 'Jaan Leppik' }, Appointments: [liveRaw('a')] } } })
    deps.readPublished = () => Promise.reject(new Error('Fiona is down'))

    const { users } = await liveAppointmentsReport({ userIds: [5], ...deps })

    expect(users[0].live.ok).toBe(true)
    expect(users[0].published).toMatchObject({ ok: false, error: 'Fiona is down' })
    expect(users[0].comparison).toBeNull()
  })

  it('skips a user that does not exist and answers for at most five', async () => {
    const deps = setup({ users: { 5: user } })

    const { users, skipped } = await liveAppointmentsReport({ userIds: [5, 99, 1, 2, 3, 4, 8], ...deps })

    expect(users.map(item => item.userId)).toEqual([5])
    expect(skipped).toEqual([{ userId: 99, reason: 'no such user' }, { userId: 1, reason: 'no such user' }, { userId: 2, reason: 'no such user' }, { userId: 3, reason: 'no such user' }])
  })

  it('has no e-mail or name of the login in its answer', async () => {
    const deps = setup({ routes: { [accountPath(5)]: { Accreditation: { Id: 'acc-1', Description: 'Jaan Leppik' }, Appointments: [liveRaw('a')] } }, publishedAnswer: { ok: true, programmes: [], appointments: [published('a')] } })

    const text = JSON.stringify(await liveAppointmentsReport({ userIds: [5], ...deps }))

    expect(text).not.toContain('jaan@example.ee')
    expect(text).not.toContain('alias@example.ee')
    expect(text).not.toContain('Jaan Leppik')
  })
})
