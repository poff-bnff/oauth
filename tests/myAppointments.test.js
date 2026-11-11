import { describe, it, expect, vi } from 'vitest'
import { appointmentsForPerson, appointmentsReport, createCache, CARD_TTL_MS, CARD_STALE_MS, PROFILE_TTL_MS } from '../server/utils/fiona/myAppointments.js'

const silent = { info () {}, warn () {}, error () {} }
const minutes = n => n * 60 * 1000

const tr = (en, et) => [{ language: 'et', text: et }, { language: 'en', text: en }]
const member = (personId, accreditationId, name, roleKey = 'film-maker') => ({ id: `m-${personId}`, personId, accreditationId, personFullName: name, role: { key: roleKey, translations: tr(roleKey, roleKey) } })
const appointment = (id, startsOn, members = [member('fp-me', 'acc-1', 'Me'), member('fp-2', 'acc-2', 'Anna Counterpart')]) => ({
  id,
  appointmentType: { key: 'interview', translations: tr('Interview', 'Intervjuu') },
  startsOn,
  endsOn: startsOn,
  subject: `Subject ${id}`,
  isOnline: false,
  location: { id: 'l', description: 'Room 1', isOnline: false },
  members
})

const person = (overrides = {}) => ({ id: 77, fiona_person_id: 'fp-me', fiona_accreditation_id: 'acc-1', ...overrides })

const httpError = (statusCode, message = `HTTP ${statusCode}`) => Object.assign(new Error(message), { statusCode })

/** a Publication client fake: cards by accreditation id (a function or an Error is called / thrown) */
function publicationWith (cards) {
  return {
    getRaw: vi.fn((path) => {
      const id = decodeURIComponent(path.replace('/accreditations/', ''))
      const card = typeof cards[id] === 'function' ? cards[id]() : cards[id]
      return card instanceof Error ? Promise.reject(card) : Promise.resolve(card)
    })
  }
}

const listed = (fionaPersonId, slug, overrides = {}) => ({ fiona_person_id: fionaPersonId, slug_en: slug, public: true, show_in_cg_search: true, allowed_to_publish: true, festival_editions: [{ id: 59 }], ...overrides })

function strapiWith (people = []) {
  return { findPeopleByFionaIds: vi.fn(ids => Promise.resolve(people.filter(p => ids.includes(p.fiona_person_id)))) }
}

function setup ({ cards = {}, people = [], now = { value: 1_000_000 } } = {}) {
  const clock = () => now.value
  return {
    now,
    publication: publicationWith(cards),
    strapi: strapiWith(people),
    cards: createCache({ ttlMs: CARD_TTL_MS, staleMs: CARD_STALE_MS, now: clock }),
    profiles: createCache({ ttlMs: PROFILE_TTL_MS, staleMs: PROFILE_TTL_MS, now: clock }),
    log: silent
  }
}

const run = (env, overrides = {}) => appointmentsForPerson({ person: person(), publication: env.publication, strapi: env.strapi, cards: env.cards, profiles: env.profiles, log: env.log, ...overrides })

describe('appointmentsForPerson', () => {
  it('has nothing to show for a person without a Fiona accreditation, and asks Fiona nothing', async () => {
    const env = setup()

    for (const p of [null, undefined, person({ fiona_accreditation_id: '' }), person({ fiona_accreditation_id: null })]) {
      expect(await run(env, { person: p })).toEqual({ ok: true, programmes: [], appointments: [] })
    }
    expect(env.publication.getRaw).not.toHaveBeenCalled()
  })

  it('reads the card of every accreditation of the person, merges them by time and drops duplicates', async () => {
    const env = setup({
      cards: {
        'acc-1': { appointments: [appointment('late', '2026-11-09T13:30:00.000Z'), appointment('both', '2026-11-09T10:30:00.000Z')] },
        'acc-9': { appointments: [appointment('both', '2026-11-09T10:30:00.000Z'), appointment('early', '2026-11-09T09:00:00.000Z')] }
      }
    })

    const result = await run(env, { person: person({ fiona_accreditation_id: 'acc-1, acc-9' }) })

    expect(result.ok).toBe(true)
    expect(result.appointments.map(a => a.id)).toEqual(['early', 'both', 'late'])
    expect(env.publication.getRaw.mock.calls.map(call => call[0])).toEqual(['/accreditations/acc-1', '/accreditations/acc-9'])
  })

  it('marks the user among the members and leaves out the ids of the people', async () => {
    const env = setup({ cards: { 'acc-1': { appointments: [appointment('a', '2026-11-09T10:30:00.000Z')] } } })

    const [{ members }] = (await run(env)).appointments

    expect(members).toEqual([
      { name: 'Me', role: { key: 'film-maker', text: 'film-maker' }, isMe: true, slug: null },
      { name: 'Anna Counterpart', role: { key: 'film-maker', text: 'film-maker' }, isMe: false, slug: null }
    ])
  })

  it('passes the language on to the texts', async () => {
    const env = setup({ cards: { 'acc-1': { appointments: [appointment('a', '2026-11-09T10:30:00.000Z')] } } })

    const { appointments } = await run(env, { lang: 'et' })

    expect(appointments[0].type.text).toBe('Intervjuu')
  })

  it('lists the meeting programmes of the card', async () => {
    const env = setup({
      cards: {
        'acc-1': { meetingProgramParticipations: [{ meetingProgram: { id: 'p', description: 'Film Market', schedule: { description: 'One-on-one meetings 2026' } }, role: { key: 'industry-representative', translations: tr('Industry representative', 'Esindaja') } }] }
      }
    })

    const { programmes } = await run(env)

    expect(programmes).toEqual([{ id: 'p', name: 'Film Market', schedule: 'One-on-one meetings 2026', role: { key: 'industry-representative', text: 'Industry representative' } }])
  })

  describe('the cache of cards', () => {
    it('reads a card once for three minutes, then again', async () => {
      const env = setup({ cards: { 'acc-1': { appointments: [appointment('a', '2026-11-09T10:30:00.000Z')] } } })

      await run(env)
      env.now.value += CARD_TTL_MS - 1000
      await run(env)
      expect(env.publication.getRaw).toHaveBeenCalledTimes(1)

      env.now.value += 2000
      await run(env)
      expect(env.publication.getRaw).toHaveBeenCalledTimes(2)
    })

    it('serves the last copy, marked stale, when Fiona fails within 30 minutes', async () => {
      const cards = { 'acc-1': { appointments: [appointment('a', '2026-11-09T10:30:00.000Z')] } }
      const env = setup({ cards })
      await run(env)

      cards['acc-1'] = httpError(502)
      env.now.value += minutes(10)
      const result = await run(env)

      expect(result.ok).toBe(true)
      expect(result.stale).toBe(true)
      expect(result.appointments.map(a => a.id)).toEqual(['a'])
    })

    it('says the data is unavailable when Fiona fails and there is no copy, or the copy is older than 30 minutes', async () => {
      const cards = { 'acc-1': httpError(500) }
      const env = setup({ cards })
      expect(await run(env)).toEqual({ ok: false, error: 'unavailable', programmes: [], appointments: [] })

      cards['acc-1'] = { appointments: [appointment('a', '2026-11-09T10:30:00.000Z')] }
      await run(env)
      cards['acc-1'] = httpError(500)
      env.now.value += CARD_STALE_MS + 1000
      expect(await run(env)).toMatchObject({ ok: false, error: 'unavailable' })
    })

    it('shows what it has and says so when only one of two accreditations could be read', async () => {
      const env = setup({
        cards: { 'acc-1': { appointments: [appointment('a', '2026-11-09T10:30:00.000Z')] }, 'acc-9': httpError(500) }
      })

      const result = await run(env, { person: person({ fiona_accreditation_id: 'acc-1,acc-9' }) })

      expect(result.ok).toBe(true)
      expect(result.partial).toBe(true)
      expect(result.appointments.map(a => a.id)).toEqual(['a'])
    })

    it('treats "no such card" (not published) as nothing to show, not as an error, and remembers it', async () => {
      const env = setup({ cards: { 'acc-1': httpError(404) } })

      expect(await run(env)).toEqual({ ok: true, programmes: [], appointments: [] })
      await run(env)
      expect(env.publication.getRaw).toHaveBeenCalledTimes(1)
    })

    it('keeps at most the wanted number of entries, dropping the oldest', () => {
      const now = { value: 0 }
      const cache = createCache({ ttlMs: 1000, staleMs: 2000, maxEntries: 2, now: () => now.value })

      cache.set('a', 1)
      cache.set('b', 2)
      cache.set('c', 3)

      expect(cache.fresh('a')).toBeNull()
      expect(cache.fresh('b').value).toBe(2)
      expect(cache.fresh('c').value).toBe(3)
    })
  })

  describe('profile links', () => {
    const cards = { 'acc-1': { appointments: [appointment('a', '2026-11-09T10:30:00.000Z', [member('fp-me', 'acc-1', 'Me'), member('fp-2', 'acc-2', 'Anna Listed'), member('fp-3', 'acc-3', 'Bob Unlisted'), member('fp-4', 'acc-4', 'Carl Unknown')])] } }
    const people = [
      listed('fp-me', 'me-slug'),
      listed('fp-2', 'anna-listed'),
      listed('fp-3', 'bob-unlisted', { show_in_cg_search: false })
    ]

    it('links a name to the profile page only when that person has a listed public profile', async () => {
      const env = setup({ cards, people })

      const [{ members }] = (await run(env)).appointments

      expect(members.map(m => [m.name, m.slug])).toEqual([['Me', null], ['Anna Listed', 'anna-listed'], ['Bob Unlisted', null], ['Carl Unknown', null]])
    })

    it.each([
      ['not public', { public: false }],
      ['not allowed to publish', { allowed_to_publish: false }],
      ['no festival edition', { festival_editions: [] }],
      ['no slug', { slug_en: null }],
      ['not in the Creative Gate search', { show_in_cg_search: false }]
    ])('does not link a person who is %s', async (_label, change) => {
      const env = setup({ cards, people: [listed('fp-2', 'anna-listed', change)] })

      const [{ members }] = (await run(env)).appointments

      expect(members.find(m => m.name === 'Anna Listed').slug).toBeNull()
    })

    it('asks Strapi once for all the other people, never for the user, and remembers the answer for 10 minutes', async () => {
      const env = setup({ cards, people })

      await run(env)
      expect(env.strapi.findPeopleByFionaIds).toHaveBeenCalledTimes(1)
      expect(env.strapi.findPeopleByFionaIds.mock.calls[0][0].sort()).toEqual(['fp-2', 'fp-3', 'fp-4'])

      env.now.value += CARD_TTL_MS + 1000 // the card is read again, the profiles are not
      await run(env)
      expect(env.strapi.findPeopleByFionaIds).toHaveBeenCalledTimes(1)

      env.now.value += PROFILE_TTL_MS
      await run(env)
      expect(env.strapi.findPeopleByFionaIds).toHaveBeenCalledTimes(2)
    })

    it('still shows the appointments, without links, when Strapi cannot be asked', async () => {
      const env = setup({ cards, people })
      env.strapi.findPeopleByFionaIds.mockRejectedValue(new Error('strapi down'))

      const result = await run(env)

      expect(result.ok).toBe(true)
      expect(result.appointments[0].members.map(m => m.slug)).toEqual([null, null, null, null])
    })
  })
})

describe('appointmentsReport', () => {
  const strapiOf = (people, listedPeople = []) => ({
    findPersonById: vi.fn(id => Promise.resolve(people[id] ?? null)),
    findPeopleByFionaIds: vi.fn(ids => Promise.resolve(listedPeople.filter(p => ids.includes(p.fiona_person_id))))
  })

  it('shows, for each Strapi person, exactly what that person would see, read from Fiona now (not from the cache)', async () => {
    const strapi = strapiOf({
      77: { id: 77, firstNameLastName: 'Eunhye Hong Kim', fiona_person_id: 'fp-me', fiona_accreditation_id: 'acc-1' },
      78: { id: 78, firstNameLastName: 'No Card', fiona_person_id: 'fp-x', fiona_accreditation_id: '' },
      79: { id: 79, firstNameLastName: 'Not Synced' }
    }, [listed('fp-2', 'anna-counterpart')])
    const publication = publicationWith({ 'acc-1': { appointments: [appointment('a', '2026-11-09T10:30:00.000Z')] } })

    const report = await appointmentsReport({ personIds: [77, 78, 79, 80], strapi, publication, log: silent })

    expect(report.persons).toHaveLength(2)
    expect(report.persons[0]).toMatchObject({ personId: 77, name: 'Eunhye Hong Kim', accreditationIds: ['acc-1'], ok: true })
    expect(report.persons[0].appointments[0].members.map(m => [m.name, m.isMe, m.slug])).toEqual([['Me', true, null], ['Anna Counterpart', false, 'anna-counterpart']])
    expect(report.persons[1]).toMatchObject({ personId: 78, name: 'No Card', accreditationIds: [], ok: true, appointments: [] })
    expect(report.skipped).toEqual([
      { personId: 79, reason: 'is not managed by the Fiona sync (no Fiona person id)' },
      { personId: 80, reason: 'not found' }
    ])

    await appointmentsReport({ personIds: [77], strapi, publication, log: silent })
    expect(publication.getRaw).toHaveBeenCalledTimes(2) // no cache between calls
  })

  it('says why a person could not be read and carries on', async () => {
    const strapi = { findPersonById: vi.fn(() => Promise.reject(new Error('strapi down'))), findPeopleByFionaIds: vi.fn() }

    const report = await appointmentsReport({ personIds: [1], strapi, publication: publicationWith({}), log: silent })

    expect(report).toEqual({ persons: [], skipped: [{ personId: 1, reason: 'could not be read: strapi down' }] })
  })

  it('refuses an empty list and more than 5 persons', async () => {
    const strapi = strapiOf({})

    await expect(appointmentsReport({ personIds: [], strapi, publication: publicationWith({}) })).rejects.toThrow(/personIds/)
    await expect(appointmentsReport({ personIds: [1, 2, 3, 4, 5, 6], strapi, publication: publicationWith({}) })).rejects.toThrow(/at most 5/)
  })
})
