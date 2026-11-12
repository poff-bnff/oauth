import { describe, it, expect, vi } from 'vitest'
import { createCache, CARD_TTL_MS, CARD_STALE_MS, PROFILE_TTL_MS } from '../server/utils/fiona/myAppointments.js'
import {
  normalizeName,
  loginIdentity,
  findAccreditationsForLogin,
  appointmentsForUser,
  loginAppointmentsReport,
  PERSONS_TTL_MS,
  PERSONS_STALE_MS,
  LOOKUP_TTL_MS
} from '../server/utils/fiona/loginAppointments.js'

const silent = { info () {}, warn () {}, error () {} }

const tr = (en, et) => [{ language: 'et', text: et }, { language: 'en', text: en }]
const member = (personId, accreditationId, name) => ({ id: `m-${personId}`, personId, accreditationId, personFullName: name, role: { key: 'guest', translations: tr('Guest', 'Külaline') } })
const card = (accreditationId, personId, startsOn = '2026-11-12T06:00:00.000Z') => ({
  id: accreditationId,
  appointments: [{
    id: `a-${accreditationId}`,
    appointmentType: { key: 'interview', translations: tr('Interview', 'Intervjuu') },
    startsOn,
    endsOn: startsOn,
    subject: 'Subject',
    isOnline: false,
    location: { id: 'l', description: 'Room 1', isOnline: false },
    members: [member(personId, accreditationId, 'Me')]
  }]
})

const httpError = (statusCode, message = `HTTP ${statusCode}`) => Object.assign(new Error(message), { statusCode })

/**
 * The world as Fiona and Strapi show it:
 *   fionaPersons  [{ id, fullName, email, myPoffId, accreditations: [{ id, guestbook }] }]
 *   cards         accreditation id → raw card
 */
function setup ({ fionaPersons = [], cards = {}, activeGuestbooks = ['gb-now'], now = { value: 1_000_000 } } = {}) {
  const clock = () => now.value
  const state = { listFails: false, xapiFails: new Set() }
  const publication = {
    getRaw: vi.fn((path) => {
      if (path === '/persons') {
        return state.listFails ? Promise.reject(httpError(503)) : Promise.resolve(fionaPersons.map(p => ({ id: p.id, fullName: p.fullName })))
      }
      const detail = path.match(/^\/persons\/(.+)$/)
      if (detail) {
        const found = fionaPersons.find(p => p.id === decodeURIComponent(detail[1]))
        return found ? Promise.resolve({ id: found.id, fullName: found.fullName, accreditations: found.accreditations.map(a => ({ id: a.id, guestbook: { id: a.guestbook, description: a.guestbook } })) }) : Promise.reject(httpError(404))
      }
      const id = decodeURIComponent(path.replace('/accreditations/', ''))
      return cards[id] ? Promise.resolve(cards[id]) : Promise.reject(httpError(404))
    })
  }
  const xapi = {
    getPerson: vi.fn((id) => {
      if (state.xapiFails.has(id)) return Promise.reject(httpError(500))
      const found = fionaPersons.find(p => p.id === id)
      return Promise.resolve({ firstName: 'x', lastName: 'y', email: found?.email ?? null })
    }),
    getMyPoffUserId: vi.fn(id => Promise.resolve(fionaPersons.find(p => p.id === id)?.myPoffId ?? null))
  }
  const strapi = {
    getActiveGuestbookIds: vi.fn(() => Promise.resolve(activeGuestbooks)),
    findPeopleByFionaIds: vi.fn(() => Promise.resolve([]))
  }
  return {
    state,
    now,
    publication,
    xapi,
    strapi,
    cards: createCache({ ttlMs: CARD_TTL_MS, staleMs: CARD_STALE_MS, now: clock }),
    profiles: createCache({ ttlMs: PROFILE_TTL_MS, staleMs: PROFILE_TTL_MS, now: clock }),
    persons: createCache({ ttlMs: PERSONS_TTL_MS, staleMs: PERSONS_STALE_MS, maxEntries: 5, now: clock }),
    found: createCache({ ttlMs: LOOKUP_TTL_MS, maxEntries: 50, now: clock }),
    log: silent
  }
}

const identityOf = (overrides = {}) => ({ userIds: [23969, 22135], emails: ['jaan@example.com'], names: ['jaan leppik'], ...overrides })

const fionaJaan = (overrides = {}) => ({ id: 'fp-jaan', fullName: 'Jaan Leppik', email: 'Jaan@Example.com', myPoffId: null, accreditations: [{ id: 'acc-now', guestbook: 'gb-now' }], ...overrides })

const lookup = (env, overrides = {}) => findAccreditationsForLogin({
  identity: identityOf(),
  publication: env.publication,
  xapi: env.xapi,
  strapi: env.strapi,
  persons: env.persons,
  found: env.found,
  log: env.log,
  ...overrides
})

describe('normalizeName', () => {
  it('compares names without case, accents or extra spaces', () => {
    expect(normalizeName('  Jaan   LEPPIK ')).toBe('jaan leppik')
    expect(normalizeName('Märt Õunapuu')).toBe(normalizeName('MART OUNAPUU'))
    expect(normalizeName(null)).toBe('')
    expect(normalizeName(undefined)).toBe('')
  })
})

describe('loginIdentity: who is this login (the main account and its aliases)', () => {
  const person = (id, first, last) => ({ id, firstName: first, lastName: last, firstNameLastName: `${first} ${last}` })

  it('collects the ids, the e-mails and the names of the main account and of every alias', async () => {
    const user = {
      id: 23969,
      email: 'Main@Example.com',
      person: null,
      aliasUsers: [
        { id: 22135, email: 'jaan@example.com', person: person(120, 'Jaan', 'Leppik') },
        { id: 29348, email: 'other@example.com', person: null }
      ]
    }

    const identity = await loginIdentity(user, { loadPerson: vi.fn() })

    expect(identity.userIds).toEqual([23969, 22135, 29348])
    expect(identity.emails).toEqual(['main@example.com', 'jaan@example.com', 'other@example.com'])
    expect(identity.names).toEqual(['jaan leppik'])
  })

  it('loads a person that comes as an id only, and leaves out a person that cannot be loaded', async () => {
    const loadPerson = vi.fn(id => (id === 5 ? Promise.resolve(person(5, 'Anna', 'Kask')) : Promise.reject(new Error('gone'))))
    const user = { id: 1, email: 'a@example.com', person: { id: 5 }, aliasUsers: [{ id: 2, email: 'b@example.com', person: { id: 6 } }] }

    const identity = await loginIdentity(user, { loadPerson })

    expect(identity.names).toEqual(['anna kask'])
  })

  it('loads a person that comes as a plain id, as Strapi gives the relations of the alias accounts', async () => {
    const loadPerson = vi.fn(id => Promise.resolve(person(id, 'Jaan', 'Leppik')))
    const user = { id: 23969, email: 'main@example.com', person: null, aliasUsers: [{ id: 22135, email: 'jaan@example.com', person: 120 }, { id: 29348, email: 'x@example.com', person: null }] }

    const identity = await loginIdentity(user, { loadPerson })

    expect(loadPerson).toHaveBeenCalledWith(120)
    expect(identity.names).toEqual(['jaan leppik'])
  })

  it('has no names for a login without any person', async () => {
    const identity = await loginIdentity({ id: 1, email: 'a@example.com', person: null, aliasUsers: [] }, { loadPerson: vi.fn() })

    expect(identity.names).toEqual([])
    expect(identity.emails).toEqual(['a@example.com'])
  })

  it('does not count the same e-mail or name twice', async () => {
    const user = { id: 1, email: 'A@example.com', person: person(5, 'Anna', 'Kask'), aliasUsers: [{ id: 2, email: 'a@example.com', person: person(6, 'ANNA', 'Kask') }] }

    const identity = await loginIdentity(user, { loadPerson: vi.fn() })

    expect(identity.emails).toEqual(['a@example.com'])
    expect(identity.names).toEqual(['anna kask'])
  })
})

describe('findAccreditationsForLogin: the Fiona accreditations of a login whose person has no Fiona ids', () => {
  it('finds the person by name and accepts it when its Fiona e-mail is one of the login e-mails', async () => {
    const env = setup({ fionaPersons: [fionaJaan()] })

    const result = await lookup(env)

    expect(result).toEqual({ ok: true, fionaPersonId: 'fp-jaan', accreditationIds: ['acc-now'] })
  })

  it('accepts it when Fiona has the MyPoff user id of the login instead (the e-mail differs)', async () => {
    const env = setup({ fionaPersons: [fionaJaan({ email: 'else@example.com', myPoffId: '22135' })] })

    expect((await lookup(env)).accreditationIds).toEqual(['acc-now'])
  })

  it('does NOT accept a namesake: same name, but neither the e-mail nor the MyPoff id is the login\'s', async () => {
    const env = setup({ fionaPersons: [fionaJaan({ email: 'namesake@example.com', myPoffId: '99999' })] })

    const result = await lookup(env)

    expect(result).toEqual({ ok: true, fionaPersonId: null, accreditationIds: [] })
    expect(env.publication.getRaw).not.toHaveBeenCalledWith('/persons/fp-jaan')
  })

  it('picks the verified one among several persons of the same name', async () => {
    const env = setup({
      fionaPersons: [
        fionaJaan({ id: 'fp-other', email: 'namesake@example.com', accreditations: [{ id: 'acc-other', guestbook: 'gb-now' }] }),
        fionaJaan()
      ]
    })

    expect(await lookup(env)).toMatchObject({ fionaPersonId: 'fp-jaan', accreditationIds: ['acc-now'] })
  })

  it('takes only the accreditations of an active guestbook (this festival), not those of earlier ones', async () => {
    const env = setup({ fionaPersons: [fionaJaan({ accreditations: [{ id: 'acc-old', guestbook: 'gb-2019' }, { id: 'acc-now', guestbook: 'gb-now' }] })] })

    expect((await lookup(env)).accreditationIds).toEqual(['acc-now'])
  })

  it('finds nothing when the login has no name, and asks Fiona nothing', async () => {
    const env = setup({ fionaPersons: [fionaJaan()] })

    const result = await lookup(env, { identity: identityOf({ names: [] }) })

    expect(result).toEqual({ ok: true, fionaPersonId: null, accreditationIds: [] })
    expect(env.publication.getRaw).not.toHaveBeenCalled()
    expect(env.xapi.getPerson).not.toHaveBeenCalled()
  })

  it('finds nothing when no person of Fiona has that name', async () => {
    const env = setup({ fionaPersons: [fionaJaan({ fullName: 'Someone Else' })] })

    expect((await lookup(env)).accreditationIds).toEqual([])
    expect(env.xapi.getPerson).not.toHaveBeenCalled()
  })

  it('looks at no more than 5 persons of the same name', async () => {
    const many = Array.from({ length: 8 }, (_, i) => fionaJaan({ id: `fp-${i}`, email: `n${i}@example.com` }))
    const env = setup({ fionaPersons: many })

    await lookup(env)

    expect(env.xapi.getPerson).toHaveBeenCalledTimes(5)
  })

  it('asks the MyPoff id only when the e-mail did not settle it', async () => {
    const env = setup({ fionaPersons: [fionaJaan()] })

    await lookup(env)

    expect(env.xapi.getMyPoffUserId).not.toHaveBeenCalled()
  })

  it('does not accept a person whose e-mail is empty on both sides', async () => {
    const env = setup({ fionaPersons: [fionaJaan({ email: null })] })

    expect((await lookup(env, { identity: identityOf({ emails: [''] }) })).accreditationIds).toEqual([])
  })

  it('says it could not tell when Fiona cannot be read: the list of persons, or the check of every candidate', async () => {
    const down = setup({ fionaPersons: [fionaJaan()] })
    down.state.listFails = true
    expect(await lookup(down)).toEqual({ ok: false })

    const broken = setup({ fionaPersons: [fionaJaan()] })
    broken.state.xapiFails.add('fp-jaan')
    expect(await lookup(broken)).toEqual({ ok: false })
  })

  it('still accepts a verified person when the check of another candidate failed', async () => {
    const env = setup({ fionaPersons: [fionaJaan({ id: 'fp-bad' }), fionaJaan()] })
    env.state.xapiFails.add('fp-bad')

    expect((await lookup(env)).accreditationIds).toEqual(['acc-now'])
  })

  it('does not ask Strapi for the active guestbooks when there is nothing to filter', async () => {
    const env = setup({ fionaPersons: [fionaJaan({ email: 'namesake@example.com' })] })

    await lookup(env)

    expect(env.strapi.getActiveGuestbookIds).not.toHaveBeenCalled()
  })

  describe('caches', () => {
    it('reads the list of persons once an hour, for every login', async () => {
      const env = setup({ fionaPersons: [fionaJaan()] })

      await lookup(env)
      await lookup(env, { identity: identityOf({ userIds: [1], emails: ['x@example.com'], names: ['jaan leppik'] }) })

      expect(env.publication.getRaw.mock.calls.filter(([path]) => path === '/persons')).toHaveLength(1)

      env.now.value += PERSONS_TTL_MS + 1
      await lookup(env, { identity: identityOf({ userIds: [2], emails: ['y@example.com'], names: ['jaan leppik'] }) })

      expect(env.publication.getRaw.mock.calls.filter(([path]) => path === '/persons')).toHaveLength(2)
    })

    it('uses the old list (up to a day) when Fiona fails to give a new one', async () => {
      const env = setup({ fionaPersons: [fionaJaan()] })
      await lookup(env)

      env.now.value += PERSONS_TTL_MS + 1
      env.state.listFails = true
      const result = await lookup(env, { identity: identityOf({ userIds: [3], emails: ['jaan@example.com'], names: ['jaan leppik'] }) })

      expect(result.accreditationIds).toEqual(['acc-now'])
    })

    it('remembers the answer for a login for five minutes, found or not', async () => {
      const env = setup({ fionaPersons: [fionaJaan()] })

      await lookup(env)
      const calls = env.xapi.getPerson.mock.calls.length
      await lookup(env)

      expect(env.xapi.getPerson.mock.calls.length).toBe(calls)

      env.now.value += LOOKUP_TTL_MS + 1
      await lookup(env)

      expect(env.xapi.getPerson.mock.calls.length).toBe(calls + 1)
    })

    it('does not remember "could not tell"', async () => {
      const env = setup({ fionaPersons: [fionaJaan()] })
      env.state.listFails = true
      expect(await lookup(env)).toEqual({ ok: false })

      env.state.listFails = false

      expect((await lookup(env)).accreditationIds).toEqual(['acc-now'])
    })
  })
})

describe('appointmentsForUser: appointments of a logged-in user, by the Strapi person or else by the login', () => {
  const personWith = (overrides = {}) => ({ id: 120, firstNameLastName: 'Jaan Leppik', fiona_person_id: null, fiona_accreditation_id: null, ...overrides })
  const userOf = (overrides = {}) => ({
    id: 23969,
    email: 'main@example.com',
    person: null,
    aliasUsers: [{ id: 22135, email: 'jaan@example.com', person: { id: 120 } }],
    ...overrides
  })
  const run = (env, user, overrides = {}) => appointmentsForUser({
    user,
    loadPerson: overrides.loadPerson || vi.fn(id => Promise.resolve(personWith({ id }))),
    publication: env.publication,
    xapi: env.xapi,
    strapi: env.strapi,
    cards: env.cards,
    profiles: env.profiles,
    persons: env.persons,
    found: env.found,
    log: env.log,
    ...overrides
  })

  it('uses the Fiona accreditation of the Strapi person when it has one, and never searches Fiona by name', async () => {
    const env = setup({ cards: { 'acc-1': card('acc-1', 'fp-me') }, fionaPersons: [fionaJaan()] })
    const loadPerson = vi.fn(id => Promise.resolve(personWith({ id, fiona_person_id: 'fp-me', fiona_accreditation_id: 'acc-1' })))

    const result = await run(env, userOf({ person: { id: 77 } }), { loadPerson })

    expect(result.appointments).toHaveLength(1)
    expect(env.publication.getRaw).not.toHaveBeenCalledWith('/persons')
    expect(env.xapi.getPerson).not.toHaveBeenCalled()
  })

  it('works when the persons come as plain ids (alias person 120, main account person 77)', async () => {
    const env = setup({ fionaPersons: [fionaJaan()], cards: { 'acc-now': card('acc-now', 'fp-jaan') } })

    const viaAlias = await run(env, userOf({ aliasUsers: [{ id: 22135, email: 'jaan@example.com', person: 120 }] }))
    expect(viaAlias.appointments).toHaveLength(1)

    const own = setup({ cards: { 'acc-1': card('acc-1', 'fp-me') } })
    const loadPerson = vi.fn(id => Promise.resolve(personWith({ id, fiona_person_id: 'fp-me', fiona_accreditation_id: 'acc-1' })))
    const viaPerson = await run(own, userOf({ person: 77 }), { loadPerson })
    expect(viaPerson.appointments).toHaveLength(1)
    expect(loadPerson).toHaveBeenCalledWith(77)
  })

  it('finds the accreditation through the login when the person has none: main account without a person, the alias\' person has the name', async () => {
    const env = setup({ fionaPersons: [fionaJaan()], cards: { 'acc-now': card('acc-now', 'fp-jaan') } })

    const result = await run(env, userOf())

    expect(result.ok).toBe(true)
    expect(result.appointments).toHaveLength(1)
    expect(result.appointments[0].members[0].isMe).toBe(true)
  })

  it('shows nothing when no person of Fiona is proven to be this login', async () => {
    const env = setup({ fionaPersons: [fionaJaan({ email: 'namesake@example.com' })], cards: { 'acc-now': card('acc-now', 'fp-jaan') } })

    const result = await run(env, userOf())

    expect(result).toEqual({ ok: true, programmes: [], appointments: [] })
    expect(env.publication.getRaw).not.toHaveBeenCalledWith('/accreditations/acc-now')
  })

  it('shows nothing, without asking Fiona, for a login without a person', async () => {
    const env = setup({ fionaPersons: [fionaJaan()] })

    const result = await run(env, userOf({ aliasUsers: [] }))

    expect(result).toEqual({ ok: true, programmes: [], appointments: [] })
    expect(env.publication.getRaw).not.toHaveBeenCalled()
  })

  it('says "unavailable" when the search in Fiona could not be made', async () => {
    const env = setup({ fionaPersons: [fionaJaan()] })
    env.state.listFails = true

    expect(await run(env, userOf())).toEqual({ ok: false, error: 'unavailable', programmes: [], appointments: [] })
  })

  it('shows nothing for a verified person whose accreditation has no published card', async () => {
    const env = setup({ fionaPersons: [fionaJaan()], cards: {} })

    expect(await run(env, userOf())).toEqual({ ok: true, programmes: [], appointments: [] })
  })

  it('passes the language on', async () => {
    const env = setup({ fionaPersons: [fionaJaan()], cards: { 'acc-now': card('acc-now', 'fp-jaan') } })

    const result = await run(env, userOf(), { lang: 'et' })

    expect(result.appointments[0].type.text).toBe('Intervjuu')
  })
})

describe('loginAppointmentsReport: what a login would see, and how its accreditation was found (read-only check)', () => {
  const personWith = (overrides = {}) => ({ id: 120, firstNameLastName: 'Jaan Leppik', fiona_person_id: null, fiona_accreditation_id: null, ...overrides })
  const jaanLogin = { id: 23969, email: 'main@example.com', person: null, aliasUsers: [{ id: 22135, email: 'jaan@example.com', person: { id: 120 } }] }
  const report = (env, userIds, overrides = {}) => loginAppointmentsReport({
    userIds,
    loadUser: vi.fn(id => (id === 22135 || id === 23969 ? Promise.resolve(jaanLogin) : (id === 500 ? Promise.reject(new Error('strapi down')) : Promise.resolve(null)))),
    loadPerson: vi.fn(id => Promise.resolve(personWith({ id }))),
    publication: env.publication,
    xapi: env.xapi,
    strapi: env.strapi,
    log: env.log,
    ...overrides
  })

  it('shows, for each login, how the accreditation was found and what the festival site would show', async () => {
    const env = setup({ fionaPersons: [fionaJaan()], cards: { 'acc-now': card('acc-now', 'fp-jaan') } })

    const result = await report(env, [22135])

    expect(result.skipped).toEqual([])
    expect(result.persons).toHaveLength(1)
    expect(result.persons[0]).toMatchObject({ userId: 22135, source: 'login', fionaPersonId: 'fp-jaan', accreditationIds: ['acc-now'], ok: true })
    expect(result.persons[0].appointments).toHaveLength(1)
    expect(result.persons[0].identity).toEqual({ accounts: 2, emails: 2, names: 1 })
  })

  it('does not put the e-mails or names of the login into the report', async () => {
    const env = setup({ fionaPersons: [fionaJaan()], cards: { 'acc-now': card('acc-now', 'fp-jaan') } })

    const text = JSON.stringify(await report(env, [22135]))

    expect(text).not.toContain('example.com')
    expect(text).not.toContain('Leppik')
  })

  it('says "person" as the source when the Strapi person has the Fiona accreditation', async () => {
    const env = setup({ cards: { 'acc-1': card('acc-1', 'fp-me') } })
    const loadPerson = vi.fn(id => Promise.resolve(personWith({ id, fiona_person_id: 'fp-me', fiona_accreditation_id: 'acc-1' })))
    const user = { id: 1, email: 'a@example.com', person: { id: 77 }, aliasUsers: [] }

    const result = await report(env, [1], { loadUser: () => Promise.resolve(user), loadPerson })

    expect(result.persons[0]).toMatchObject({ userId: 1, source: 'person', accreditationIds: ['acc-1'] })
  })

  it('reads Fiona afresh at every call: no cache between calls', async () => {
    const env = setup({ fionaPersons: [fionaJaan()], cards: { 'acc-now': card('acc-now', 'fp-jaan') } })

    await report(env, [22135])
    await report(env, [22135])

    expect(env.publication.getRaw.mock.calls.filter(([path]) => path === '/persons')).toHaveLength(2)
  })

  it('says why a login could not be read and carries on', async () => {
    const env = setup({ fionaPersons: [fionaJaan()], cards: { 'acc-now': card('acc-now', 'fp-jaan') } })

    const result = await report(env, [500, 404, 22135])

    expect(result.skipped).toEqual([
      { userId: 500, reason: 'could not be read: strapi down' },
      { userId: 404, reason: 'not found' }
    ])
    expect(result.persons.map(p => p.userId)).toEqual([22135])
  })

  it('refuses an empty list and more than 5 logins', async () => {
    const env = setup()

    await expect(report(env, [])).rejects.toThrow(/userIds/)
    await expect(report(env, [1, 2, 3, 4, 5, 6])).rejects.toThrow(/at most 5/)
  })
})
