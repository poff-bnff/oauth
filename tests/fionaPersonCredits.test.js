import { describe, it, expect } from 'vitest'
import { creditsPatch, creditCount, CREDIT_SOURCES } from '../server/utils/fiona/personCredits.js'

const FROM = 500
const TO = 20

// a film as the REST route returns it: components with ids, relations populated
const film = (rolePersons, extra = {}) => ({
  id: 9213,
  title_en: 'A film',
  credentials: {
    id: 77,
    rolePerson: rolePersons,
    roleCompany: [{ id: 301, company: { id: 5, name: 'Acme' } }]
  },
  ...extra
})
const credit = (id, person, extra = {}) => ({ id, order: id, role_at_film: { id: 3, name: 'Director' }, person: person === null ? null : { id: person, firstName: 'Mari' }, actor_role: null, note: null, ...extra })

describe('creditsPatch: films, course events and projects (credits inside components)', () => {
  it('points the credit to the other person and sends every row of the list with its id, so nothing is deleted or reordered', () => {
    const entry = film([credit(11, 99), credit(12, FROM), credit(13, 98)])

    const result = creditsPatch({ source: 'film', entry, fromId: FROM, toId: TO })

    expect(result).toMatchObject({ ok: true, found: true })
    expect(result.patch).toEqual({ credentials: { id: 77, rolePerson: [{ id: 11 }, { id: 12, person: TO }, { id: 13 }] } })
    expect(result.changes).toEqual(['credentials.rolePerson #12: person 500 → 20'])
  })

  it('does not send what it does not change (the company credits, other fields, the persons of other rows)', () => {
    const result = creditsPatch({ source: 'film', entry: film([credit(12, FROM)]), fromId: FROM, toId: TO })

    expect(Object.keys(result.patch)).toEqual(['credentials'])
    expect(Object.keys(result.patch.credentials)).toEqual(['id', 'rolePerson'])
  })

  it('works for course events, courses and the credits of industry and DISCamp projects, which hold the same credits', () => {
    for (const [source, field] of [['course-event', 'credentials'], ['course', 'credentials'], ['industry-project', 'teamCredentials'], ['dis-camp-project', 'teamCredentials']]) {
      const entry = { id: 1, [field]: { id: 5, rolePerson: [credit(11, FROM)] } }
      expect(creditsPatch({ source, entry, fromId: FROM, toId: TO }).patch).toEqual({ [field]: { id: 5, rolePerson: [{ id: 11, person: TO }] } })
    }
  })

  it('drops the row when the other person already has the same credit in the same list (two identical credits would show the person twice)', () => {
    const entry = film([credit(11, TO), credit(12, FROM), credit(13, 98)])

    const result = creditsPatch({ source: 'film', entry, fromId: FROM, toId: TO })

    expect(result.patch.credentials.rolePerson).toEqual([{ id: 11 }, { id: 13 }])
    expect(result.dropped).toBe(1)
    expect(result.changes).toEqual(['credentials.rolePerson #12: dropped, #11 holds the same credit for 20'])
  })

  it('keeps both rows (and points the credit over) when the two credits differ in what they say', () => {
    const entry = film([credit(11, TO, { actor_role: 'Anna' }), credit(12, FROM, { actor_role: 'Boris' })])

    const result = creditsPatch({ source: 'film', entry, fromId: FROM, toId: TO })

    expect(result.patch.credentials.rolePerson).toEqual([{ id: 11 }, { id: 12, person: TO }])
    expect(result.dropped).toBe(0)
  })

  it('points a credit to the other person in several lists of one entry', () => {
    const entry = film([credit(12, FROM)])
    entry.credentials.rolePerson.push(credit(14, FROM, { role_at_film: { id: 4, name: 'Producer' } }))

    const result = creditsPatch({ source: 'film', entry, fromId: FROM, toId: TO })

    expect(result.patch.credentials.rolePerson).toEqual([{ id: 12, person: TO }, { id: 14, person: TO }])
  })

  it('finds nothing to do once the credits are pointed over, so a run can be repeated', () => {
    const result = creditsPatch({ source: 'film', entry: film([credit(12, TO)]), fromId: FROM, toId: TO })

    expect(result).toMatchObject({ ok: true, found: false, patch: null, changes: [] })
  })

  it('does not trust a row without an id: an update without it would delete and recreate the row', () => {
    const entry = film([credit(11, 99), { ...credit(12, FROM), id: undefined }])

    const result = creditsPatch({ source: 'film', entry, fromId: FROM, toId: TO })

    expect(result.ok).toBe(false)
    expect(result.reason).toMatch(/without an id/)
  })

  it('does not look at persons inside other records (a populated film inside another entry) nor at fields it does not know', () => {
    const entry = { id: 1, credentials: { id: 5, rolePerson: [credit(11, 99)] }, related: { id: 8, credentials: { id: 9, rolePerson: [credit(21, FROM)] } } }

    expect(creditsPatch({ source: 'film', entry, fromId: FROM, toId: TO })).toMatchObject({ ok: true, found: false })
  })
})

describe('creditsPatch: teams', () => {
  const team = () => ({
    id: 12,
    subTeam: [
      { id: 1, name: { id: 4 }, teamMember: [{ id: 21, person: { id: FROM }, roleAtTeam_en: 'Chair' }, { id: 22, person: { id: 99 } }], juryMember: [] },
      { id: 2, teamMember: [], juryMember: [{ id: 31, person: { id: FROM } }, { id: 32, person: { id: TO } }] }
    ]
  })

  it('points team and jury members to the other person, keeping every sub-team and member with its id', () => {
    const result = creditsPatch({ source: 'team', entry: team(), fromId: FROM, toId: TO })

    expect(result.patch).toEqual({
      subTeam: [
        { id: 1, teamMember: [{ id: 21, person: TO }, { id: 22 }] },
        { id: 2, juryMember: [{ id: 32 }] }
      ]
    })
    expect(result.dropped).toBe(1)
  })
})

describe('creditsPatch: records that hold a person directly', () => {
  it('points a filmography, client, award or DISCamp person to the other person', () => {
    expect(creditsPatch({ source: 'filmography', entry: { id: 1588, person: { id: FROM }, title: 'x' }, fromId: FROM, toId: TO }).patch).toEqual({ person: TO })
    expect(creditsPatch({ source: 'client', entry: { id: 1, client_person: { id: FROM } }, fromId: FROM, toId: TO }).patch).toEqual({ client_person: TO })
    expect(creditsPatch({ source: 'awarding', entry: { id: 1, person: FROM }, fromId: FROM, toId: TO }).patch).toEqual({ person: TO })
    expect(creditsPatch({ source: 'dis-camp-person', entry: { id: 1, person: { id: FROM } }, fromId: FROM, toId: TO }).patch).toEqual({ person: TO })
  })

  it('points an industry person and the film it lists in its own filmography', () => {
    const entry = {
      id: 177,
      person: { id: FROM },
      filmography: { id: 6, text: 'x', film: [{ id: 61, title_en: 'A', person_of_role: { id: FROM } }, { id: 62, title_en: 'B', person_of_role: { id: 99 } }] }
    }

    const result = creditsPatch({ source: 'industry-person', entry, fromId: FROM, toId: TO })

    expect(result.patch).toEqual({ person: TO, filmography: { id: 6, film: [{ id: 61, person_of_role: TO }, { id: 62 }] } })
  })

  it('swaps a person in the list of people of an article, once', () => {
    const entry = { id: 3, people: [{ id: 98 }, { id: FROM }, { id: TO }] }

    const result = creditsPatch({ source: 'industry-article', entry, fromId: FROM, toId: TO })

    expect(result.patch).toEqual({ people: [98, TO] })
    expect(result.dropped).toBe(1)
  })
})

describe('creditCount', () => {
  it('counts the credits that name a person, in the places creditsPatch looks at, a list of people once', () => {
    const entry = film([credit(11, FROM), credit(12, 99), credit(13, FROM, { role_at_film: { id: 4 } })])

    expect(creditCount('film', entry, FROM)).toBe(2)
    expect(creditCount('film', entry, 99)).toBe(1)
    expect(creditCount('film', entry, TO)).toBe(0)
    expect(creditCount('industry-article', { people: [{ id: FROM }, { id: FROM }] }, FROM)).toBe(1)
    expect(creditCount('festival-pass', { owner: { id: FROM } }, FROM)).toBe(0)
  })
})

describe('creditsPatch: what it cannot do', () => {
  it('says so for a source it does not re-point (the festival pass belongs to the person for another reason)', () => {
    const result = creditsPatch({ source: 'festival-pass', entry: { id: 1, owner: { id: FROM } }, fromId: FROM, toId: TO })

    expect(result).toMatchObject({ ok: false, supported: false })
    expect(CREDIT_SOURCES).not.toContain('festival-pass')
  })

  it('lists the sources it knows', () => {
    expect(CREDIT_SOURCES).toEqual(expect.arrayContaining(['film', 'course-event', 'course', 'industry-project', 'dis-camp-project', 'team', 'industry-person', 'dis-camp-person', 'filmography', 'client', 'awarding', 'dis-camp-article', 'industry-article']))
  })
})
