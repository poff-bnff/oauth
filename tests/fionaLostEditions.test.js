import { describe, it, expect } from 'vitest'
import { lostEditionsReport } from '../server/utils/fiona/lostEditions.js'

const silent = { info () {}, warn () {}, error () {} }

const person = (id, over = {}) => ({
  id,
  firstName: 'Emma',
  lastName: `Grape${id}`,
  firstNameLastName: `Emma Grape${id}`,
  fiona_person_id: `f-${id}`,
  fiona_attached_edition_ids: '59,114',
  fiona_synced_at: '2026-11-01T01:46:33.776Z',
  fiona_unpublished_at: null,
  festival_editions: [{ id: 59 }, { id: 114 }],
  user: { id: id + 1000 },
  public: true,
  updated_at: '2026-11-01T01:46:34.000Z',
  ...over
})

const report = people => lostEditionsReport({ strapi: { findManagedPeople: () => Promise.resolve(people) }, log: silent })

describe('lostEditionsReport: who holds less than the sync attached', () => {
  it('lists a person whose attached edition is gone, with what was lost and what is held (the Emma case)', async () => {
    const result = await report([person(40141, { festival_editions: [{ id: 59 }, { id: 113 }], updated_at: '2026-11-01T18:12:59.000Z' })])

    expect(result.persons).toEqual([{
      personId: 40141,
      name: 'Emma Grape40141',
      lostEditionIds: [114],
      heldEditionIds: [59, 113],
      attachedEditionIds: [59, 114],
      syncedAt: '2026-11-01T01:46:33.776Z',
      updatedAt: '2026-11-01T18:12:59.000Z',
      editedAfterSync: true,
      unpublished: false
    }])
  })

  it('leaves out a person who holds everything the sync attached, and one the sync attached nothing to', async () => {
    const result = await report([
      person(1),
      person(2, { fiona_attached_edition_ids: '', festival_editions: [] }),
      person(3, { fiona_attached_edition_ids: null, festival_editions: [{ id: 59 }] }),
      person(4, { festival_editions: [{ id: 59 }, { id: 114 }, { id: 113 }] })
    ])

    expect(result.persons).toEqual([])
    expect(result.managed).toBe(4)
    expect(result.withLost).toBe(0)
  })

  it('tells a save after the sync (the person\'s own profile form) from the sync\'s own write a moment before', async () => {
    const result = await report([
      person(1, { festival_editions: [{ id: 59 }], updated_at: '2026-11-01T01:46:35.000Z' }), // the sync's own save, a second later
      person(2, { festival_editions: [{ id: 59 }], updated_at: '2026-11-01T09:00:00.000Z' }),
      person(3, { festival_editions: [{ id: 59 }], fiona_synced_at: null, updated_at: '2026-11-01T09:00:00.000Z' })
    ])

    expect(result.persons.map(p => [p.personId, p.editedAfterSync])).toEqual([[1, false], [2, true], [3, null]])
  })

  it('counts per edition, most persons first, and how many of them saved after the sync', async () => {
    const result = await report([
      person(1, { festival_editions: [{ id: 59 }], updated_at: '2026-11-01T09:00:00.000Z' }),
      person(2, { festival_editions: [{ id: 59 }], updated_at: '2026-11-01T01:46:34.000Z' }),
      person(3, { fiona_attached_edition_ids: '59,86', festival_editions: [], updated_at: '2026-11-01T09:00:00.000Z' })
    ])

    expect(result.byEdition).toEqual([
      { editionId: 114, persons: 2, editedAfterSync: 1 },
      { editionId: 59, persons: 1, editedAfterSync: 1 },
      { editionId: 86, persons: 1, editedAfterSync: 1 }
    ])
    expect(result).toMatchObject({ managed: 3, withLost: 3, withLostAfterSave: 2 })
  })

  it('reads the attached ids as a comma list and the held editions as ids or relation objects', async () => {
    const result = await report([person(1, { fiona_attached_edition_ids: ' 59, 114 ,x', festival_editions: [59, { id: '113' }] })])

    expect(result.persons[0]).toMatchObject({ lostEditionIds: [114], heldEditionIds: [59, 113], attachedEditionIds: [59, 114] })
  })

  it('skips a record that is not managed by the sync, names the person from the name parts when needed, and marks an unpublished one', async () => {
    const result = await report([
      person(1, { fiona_person_id: null, festival_editions: [] }),
      person(2, { firstNameLastName: null, firstName: 'Mari', lastName: 'Maasikas', festival_editions: [], fiona_unpublished_at: '2026-11-01T05:00:00.000Z' })
    ])

    expect(result.managed).toBe(1)
    expect(result.persons).toMatchObject([{ personId: 2, name: 'Mari Maasikas', unpublished: true }])
  })

  it('lists the persons by id', async () => {
    const result = await report([person(9, { festival_editions: [] }), person(3, { festival_editions: [] }), person(5, { festival_editions: [] })])

    expect(result.persons.map(p => p.personId)).toEqual([3, 5, 9])
  })

  it('says so when Strapi cannot be read, instead of an empty report', async () => {
    await expect(lostEditionsReport({ strapi: { findManagedPeople: () => Promise.reject(new Error('HTTP 500')) }, log: silent })).rejects.toThrow(/500/)
  })
})
