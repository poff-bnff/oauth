import { describe, it, expect } from 'vitest'
import { mergeParticipation, addCategoriesToParticipation, participationHolds } from '../server/utils/fiona/participation.js'

// What GET /people/:id returns for Person.participationHistory (component person.participation-history): entries with an id,
// the edition and the two lists expanded to objects.
const entry = (id, edition, categories = [], types = []) => ({
  id,
  festival_edition: edition === null ? null : { id: edition, name_en: `edition ${edition}` },
  industry_categories: categories.map(categoryId => ({ id: categoryId, name: `category ${categoryId}` })),
  industry_person_types: types.map(typeId => ({ id: typeId, name: `type ${typeId}` }))
})

describe('mergeParticipation: the entries of the person that is merged away go to the person that stays, per edition', () => {
  it('has nothing to do when the removed person has no entries', () => {
    expect(mergeParticipation([entry(1, 114, [7])], [])).toBeNull()
    expect(mergeParticipation([], undefined)).toBeNull()
  })

  it('adds the entry of an edition the kept person has no entry for; the kept entries are sent by id only', () => {
    const result = mergeParticipation([entry(1, 80, [3])], [entry(9, 114, [7, 8], [5])])

    expect(result.rows).toEqual([
      { id: 1 },
      { festival_edition: 114, industry_categories: [7, 8], industry_person_types: [5] }
    ])
    expect(result).toMatchObject({ entriesAdded: 1, entriesUpdated: 0, links: 3, problem: null })
  })

  it('combines the lists of the two entries of the same edition: all the kept ones and the new ones, in one list', () => {
    const result = mergeParticipation([entry(1, 114, [7], [5]), entry(2, 80, [3])], [entry(9, 114, [7, 8], [6])])

    expect(result.rows).toEqual([
      { id: 1, industry_categories: [7, 8], industry_person_types: [5, 6] },
      { id: 2 }
    ])
    expect(result).toMatchObject({ entriesAdded: 0, entriesUpdated: 1, links: 2 })
  })

  it('sends only the list that grew, so the other list is left as it is', () => {
    const result = mergeParticipation([entry(1, 114, [7], [5])], [entry(9, 114, [7], [6])])

    expect(result.rows).toEqual([{ id: 1, industry_person_types: [5, 6] }])
  })

  it('has nothing to do when the kept entry already holds everything', () => {
    expect(mergeParticipation([entry(1, 114, [7, 8], [5])], [entry(9, 114, [8], [5])])).toBeNull()
  })

  it('handles several editions at once', () => {
    const result = mergeParticipation([entry(1, 114, [7])], [entry(9, 114, [8]), entry(10, 80, [3]), entry(11, 81, [])])

    expect(result.rows).toEqual([
      { id: 1, industry_categories: [7, 8] },
      { festival_edition: 80, industry_categories: [3], industry_person_types: [] },
      { festival_edition: 81, industry_categories: [], industry_person_types: [] }
    ])
    expect(result).toMatchObject({ entriesAdded: 2, entriesUpdated: 1, links: 2 })
  })

  it('two entries of the same edition on the removed person end up in one entry', () => {
    const result = mergeParticipation([], [entry(9, 114, [7]), entry(10, 114, [8], [5])])

    expect(result.rows).toEqual([{ festival_edition: 114, industry_categories: [7, 8], industry_person_types: [5] }])
  })

  it('does not carry an entry without an edition (it belongs to no year)', () => {
    expect(mergeParticipation([entry(1, 114, [7])], [entry(9, null, [8])])).toBeNull()
  })

  it('refuses when an entry it has to combine cannot be read (the lists are not in the answer of Strapi)', () => {
    const unreadable = { id: 1, festival_edition: { id: 114 } } // no lists at all
    const result = mergeParticipation([unreadable], [entry(9, 114, [8])])

    expect(result.rows).toBeNull()
    expect(result.problem).toMatch(/cannot be read/i)
  })

  it('refuses when the removed person entry cannot be read', () => {
    const result = mergeParticipation([entry(1, 114, [7])], [{ id: 9, festival_edition: { id: 114 } }])

    expect(result.rows).toBeNull()
    expect(result.problem).toMatch(/cannot be read/i)
  })

  it('refuses when the kept person has no participationHistory field at all in the answer but entries are to be carried', () => {
    expect(mergeParticipation(undefined, [entry(9, 114, [8])]).problem).toMatch(/cannot be read/i)
    expect(mergeParticipation([], [entry(9, 114, [8])]).rows).toEqual([{ festival_edition: 114, industry_categories: [8], industry_person_types: [] }])
  })

  it('refuses when an entry comes without its edition field at all', () => {
    const noEdition = { id: 1, industry_categories: [], industry_person_types: [] }

    expect(mergeParticipation([noEdition], [entry(9, 114, [8])]).problem).toMatch(/cannot be read/i)
    expect(mergeParticipation([entry(1, 114, [8])], [noEdition]).problem).toMatch(/cannot be read/i)
  })

  it('accepts plain ids where Strapi gives ids instead of objects', () => {
    const result = mergeParticipation([{ id: 1, festival_edition: 114, industry_categories: [7], industry_person_types: [] }], [{ id: 9, festival_edition: 114, industry_categories: [8], industry_person_types: [] }])

    expect(result.rows).toEqual([{ id: 1, industry_categories: [7, 8] }])
  })
})

describe('addCategoriesToParticipation: the categories the sync matched go into the entry of the edition (add only)', () => {
  it('makes the entry when the person has none for the edition', () => {
    const result = addCategoriesToParticipation([], { editionId: 114, categoryIds: [7, 8] })

    expect(result.rows).toEqual([{ festival_edition: 114, industry_categories: [7, 8] }])
    expect(result).toMatchObject({ created: true, links: 2, problem: null })
  })

  it('leaves the entries of other editions as they are, sent by id only', () => {
    const result = addCategoriesToParticipation([entry(1, 80, [3])], { editionId: 114, categoryIds: [7] })

    expect(result.rows).toEqual([{ id: 1 }, { festival_edition: 114, industry_categories: [7] }])
  })

  it('adds to the categories of the existing entry: the whole list, old and new', () => {
    const result = addCategoriesToParticipation([entry(1, 80, [3]), entry(2, 114, [7], [5])], { editionId: 114, categoryIds: [7, 8] })

    expect(result.rows).toEqual([{ id: 1 }, { id: 2, industry_categories: [7, 8] }])
    expect(result).toMatchObject({ created: false, links: 1 })
  })

  it('does nothing when the entry holds all of them already, or when there is nothing to add', () => {
    expect(addCategoriesToParticipation([entry(2, 114, [7, 8])], { editionId: 114, categoryIds: [8, 7] })).toBeNull()
    expect(addCategoriesToParticipation([], { editionId: 114, categoryIds: [] })).toBeNull()
  })

  it('uses the first entry when the person has two for the edition', () => {
    const result = addCategoriesToParticipation([entry(1, 114, [7]), entry(2, 114, [9])], { editionId: 114, categoryIds: [8] })

    expect(result.rows).toEqual([{ id: 1, industry_categories: [7, 8] }, { id: 2 }])
  })

  it('refuses to guess when the entry cannot be read: it would replace the list with the new ids only', () => {
    const result = addCategoriesToParticipation([{ id: 2, festival_edition: { id: 114 } }], { editionId: 114, categoryIds: [8] })

    expect(result.rows).toBeNull()
    expect(result.problem).toMatch(/cannot be read/i)
  })

  it('refuses when an entry comes without its edition field at all: a duplicate entry would be made for an edition it may hold', () => {
    const noEdition = { id: 2, industry_categories: [], industry_person_types: [] }
    const result = addCategoriesToParticipation([noEdition], { editionId: 114, categoryIds: [8] })

    expect(result.rows).toBeNull()
    expect(result.problem).toMatch(/cannot be read/i)
  })

  it('refuses when the person has no participationHistory field at all in the answer (an empty list is [], a missing field means Strapi did not send it)', () => {
    const result = addCategoriesToParticipation(undefined, { editionId: 114, categoryIds: [8] })

    expect(result.rows).toBeNull()
    expect(result.problem).toMatch(/cannot be read/i)
  })

  it('does nothing without a valid edition id', () => {
    expect(addCategoriesToParticipation([], { editionId: 0, categoryIds: [7] })).toBeNull()
  })
})

describe('participationHolds: after the write, does the person hold what was meant?', () => {
  it('is true when every sent list is in the entry and no entry was lost', () => {
    const sent = [{ id: 1, industry_categories: [7, 8] }, { id: 2 }, { festival_edition: 80, industry_categories: [3], industry_person_types: [] }]
    const after = [entry(1, 114, [7, 8, 9]), entry(2, 81, []), entry(3, 80, [3])]

    expect(participationHolds(after, sent)).toBe(true)
  })

  it('is false when a list lost an id', () => {
    expect(participationHolds([entry(1, 114, [7])], [{ id: 1, industry_categories: [7, 8] }])).toBe(false)
  })

  it('is false when an entry that was sent by id is gone', () => {
    expect(participationHolds([entry(1, 114, [7])], [{ id: 1 }, { id: 2 }])).toBe(false)
  })

  it('is false when a new entry did not arrive', () => {
    expect(participationHolds([entry(1, 114, [7])], [{ id: 1 }, { festival_edition: 80, industry_categories: [3], industry_person_types: [] }])).toBe(false)
  })
})
