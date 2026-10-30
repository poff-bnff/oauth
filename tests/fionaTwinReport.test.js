import { describe, it, expect } from 'vitest'
import { nameKey, searchTerms, classifyPair, buildTwinReport } from '../server/utils/fiona/twinReport.js'

const silent = { info () {}, warn () {}, error () {} }

describe('nameKey', () => {
  it('ignores case, accents and punctuation, and falls back to first + last name', () => {
    expect(nameKey({ firstNameLastName: 'Tõnis  PILL' })).toBe('tonis pill')
    expect(nameKey({ firstName: 'Tõnis', lastName: 'Pill' })).toBe('tonis pill')
    expect(nameKey({ firstNameLastName: 'Jean-Luc Godard' })).toBe(nameKey({ firstName: 'Jean Luc', lastName: 'Godard' }))
    expect(nameKey({})).toBe('')
  })
})

describe('searchTerms', () => {
  it('searches Strapi by the longest word of the last name, and by its accent-free form too', () => {
    expect(searchTerms({ firstName: 'Mari', lastName: 'Maasikas' })).toEqual(['Maasikas'])
    expect(searchTerms({ firstName: 'Kaie', lastName: 'Sõber-Õun' })).toEqual(['Sõber', 'sober'])
  })

  it('falls back to the whole name when there is no last name, and to nothing for a name too short to search', () => {
    expect(searchTerms({ firstNameLastName: 'Madonna' })).toEqual(['Madonna'])
    expect(searchTerms({ firstNameLastName: 'Li' })).toEqual([])
    expect(searchTerms({})).toEqual([])
  })
})

describe('classifyPair', () => {
  const copy = { id: 500, email: 'mari@acme.ee', userId: 70, remoteId: null }
  const twin = { id: 20, email: null, userId: null, remoteId: null }
  const base = { copy, twin, twinCount: 1, managedInGroup: 1, copyRefs: [], twinRefs: [] }

  it('A: one older twin without an e-mail, nothing else involved', () => {
    expect(classifyPair(base)).toEqual({ tier: 'A', reasons: ['one older twin without e-mail'] })
  })

  it('A: the twin holds the same e-mail, whatever the case', () => {
    const result = classifyPair({ ...base, twin: { ...twin, email: ' Mari@ACME.ee ' } })
    expect(result.tier).toBe('A')
    expect(result.reasons).toEqual(['one older twin with the same e-mail'])
  })

  it('B: the twin has another e-mail, or there are several twins, or it is an Eventival film person, or it is newer than the copy', () => {
    expect(classifyPair({ ...base, twin: { ...twin, email: 'mari@other.ee' } })).toEqual({ tier: 'B', reasons: ['twin has another e-mail'] })
    expect(classifyPair({ ...base, twinCount: 3 })).toEqual({ tier: 'B', reasons: ['3 twins with this name'] })
    expect(classifyPair({ ...base, twin: { ...twin, remoteId: '991' } })).toEqual({ tier: 'B', reasons: ['twin is an Eventival film person'] })
    expect(classifyPair({ ...base, twin: { ...twin, id: 900 } })).toEqual({ tier: 'B', reasons: ['twin is newer than the copy'] })
  })

  it('B lists every reason', () => {
    const result = classifyPair({ ...base, twinCount: 2, twin: { ...twin, email: 'x@y.ee', remoteId: '1' } })
    expect(result.tier).toBe('B')
    expect(result.reasons).toEqual(['2 twins with this name', 'twin has another e-mail', 'twin is an Eventival film person'])
  })

  it('C: different login users, two sync-managed records, or the copy is used somewhere else', () => {
    expect(classifyPair({ ...base, twin: { ...twin, userId: 71 } })).toEqual({ tier: 'C', reasons: ['both have a login user, and not the same one'] })
    expect(classifyPair({ ...base, managedInGroup: 2 })).toEqual({ tier: 'C', reasons: ['2 sync-managed records have this name'] })
    expect(classifyPair({ ...base, copyRefs: [{ source: 'film', id: 12 }] })).toEqual({ tier: 'C', reasons: ['the copy is used in film #12'] })
  })

  it('C wins over B, and the same login user on both is no problem', () => {
    expect(classifyPair({ ...base, twinCount: 2, managedInGroup: 2 }).tier).toBe('C')
    expect(classifyPair({ ...base, twin: { ...twin, userId: 70 } }).tier).toBe('A')
  })
})

describe('buildTwinReport', () => {
  const person = (id, name, extra = {}) => ({
    id,
    firstName: name.split(' ')[0],
    lastName: name.split(' ').slice(1).join(' '),
    firstNameLastName: name,
    eMail: null,
    fiona_person_id: null,
    remoteId: null,
    user: null,
    public: true,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    picture: null,
    bio_en: null,
    festival_editions: [],
    organisations: [],
    orderedRaF: [],
    ...extra
  })

  function fakeStrapi (people, references = {}) {
    const queries = []
    return {
      queries,
      findManagedPeople: () => people.filter(p => p.fiona_person_id),
      findPeopleByNameTerm: (term) => {
        queries.push(term)
        return people.filter(p => nameKey(p).includes(String(term).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()) || String(p.lastName).toLowerCase().includes(String(term).toLowerCase()))
      },
      findPersonReferences: ids => ({
        refs: Object.fromEntries(ids.filter(id => references[id]).map(id => [id, references[id]])),
        covered: ['film', 'awarding'],
        failed: [{ source: 'festival-pass', error: 'HTTP 404' }]
      })
    }
  }

  it('pairs every sync-managed person with its same-name persons that have no Fiona id, and tiers them', async () => {
    const people = [
      person(20, 'Mari Maasikas'),
      person(500, 'Mari Maasikas', { fiona_person_id: 'f-1', eMail: 'mari@acme.ee', user: { id: 70 }, picture: { id: 9 }, festival_editions: [{ id: 86 }] }),
      person(21, 'Jaan Tamm', { eMail: 'jaan@old.ee' }),
      person(501, 'Jaan Tamm', { fiona_person_id: 'f-2', eMail: 'jaan@new.ee', user: { id: 71 } }),
      person(502, 'Kati Kask', { fiona_person_id: 'f-3', eMail: 'kati@x.ee' }),
      person(30, 'Peeter Pähkel'),
      person(31, 'Peeter Pähkel'),
      person(503, 'Peeter Pähkel', { fiona_person_id: 'f-4', eMail: 'p@x.ee' })
    ]
    const strapi = fakeStrapi(people)

    const report = await buildTwinReport({ strapi, log: silent })

    expect(report.mode).toBe('twins')
    expect(report.managed).toBe(4)
    expect(report.withoutTwin).toBe(1) // Kati Kask has no same-name person
    expect(report.tiers).toEqual({ A: 1, B: 3, C: 0 })
    const mari = report.pairs.find(pair => pair.copy.id === 500)
    expect(mari).toMatchObject({ tier: 'A', name: 'Mari Maasikas', twinCount: 1 })
    expect(mari.copy).toMatchObject({ id: 500, email: 'mari@acme.ee', fionaPersonId: 'f-1', userId: 70, hasPicture: true, editions: 1 })
    expect(mari.twin).toMatchObject({ id: 20, email: null, userId: null })
    expect(report.pairs.filter(pair => pair.copy.id === 503).map(pair => pair.twin.id).sort()).toEqual([30, 31])
    expect(report.pairs.find(pair => pair.copy.id === 501).reasons).toEqual(['twin has another e-mail'])
  })

  it('asks Strapi once per name, even when two sync-managed persons share it, and puts them in tier C', async () => {
    const people = [
      person(20, 'Ann Lee'),
      person(600, 'Ann Lee', { fiona_person_id: 'f-1', eMail: 'a@x.ee' }),
      person(601, 'Ann Lee', { fiona_person_id: 'f-2', eMail: 'b@x.ee' })
    ]
    const strapi = fakeStrapi(people)

    const report = await buildTwinReport({ strapi, log: silent })

    expect(strapi.queries).toEqual(['Lee'])
    expect(report.pairs).toHaveLength(2)
    expect(report.pairs.every(pair => pair.tier === 'C' && pair.reasons[0] === '2 sync-managed records have this name')).toBe(true)
  })

  it('moves a pair to tier C when the copy is used somewhere else, and reports which sources could not be read', async () => {
    const people = [person(20, 'Mari Maasikas'), person(500, 'Mari Maasikas', { fiona_person_id: 'f-1', eMail: 'm@x.ee' })]
    const strapi = fakeStrapi(people, { 500: [{ source: 'film', id: 12 }], 20: [{ source: 'film', id: 3 }] })

    const report = await buildTwinReport({ strapi, log: silent })

    expect(report.pairs[0].tier).toBe('C')
    expect(report.pairs[0].reasons).toEqual(['the copy is used in film #12'])
    expect(report.pairs[0].twin.usedIn).toEqual(['film #3'])
    expect(report.referenceCoverage).toEqual({ covered: ['film', 'awarding'], failed: [{ source: 'festival-pass', error: 'HTTP 404' }] })
  })

  it('does not search for persons without a usable name, and carries on when one lookup fails', async () => {
    const people = [
      person(500, '', { fiona_person_id: 'f-0', eMail: 'n@x.ee', firstName: '', lastName: '', firstNameLastName: '' }),
      person(501, 'Mari Maasikas', { fiona_person_id: 'f-1', eMail: 'm@x.ee' }),
      person(502, 'Jaan Tamm', { fiona_person_id: 'f-2', eMail: 'j@x.ee' }),
      person(20, 'Jaan Tamm')
    ]
    const strapi = fakeStrapi(people)
    const original = strapi.findPeopleByNameTerm
    strapi.findPeopleByNameTerm = (term) => { if (term === 'Maasikas') throw new Error('HTTP 500'); return original(term) }

    const report = await buildTwinReport({ strapi, log: silent })

    expect(report.pairs.map(pair => pair.copy.id)).toEqual([502])
    expect(report.lookupErrors).toEqual([{ name: 'Mari Maasikas', error: 'HTTP 500' }])
    expect(report.withoutName).toBe(1)
  })
})
