import { describe, it, expect } from 'vitest'
import { describePhotos } from '../server/utils/fiona/photoDiagnostic.js'

const silent = { info () {}, warn () {}, error () {} }
const attachment = (title, extra = {}) => ({ category: 0, type: 'Image', title, fileName: `${title}.jpg`, createdOn: null, token: `TOKEN-${title}`, ...extra })

function fakes () {
  const people = new Map([
    [10, { id: 10, firstName: 'Tõnis', lastName: 'Pill', fiona_person_id: 'fp-10', fiona_accreditation_id: 'acc-a,acc-b', picture: null }],
    [11, { id: 11, firstName: 'Mari', lastName: 'Maasikas', fiona_person_id: 'fp-11', fiona_accreditation_id: 'acc-c', picture: { id: 5 } }],
    [12, { id: 12, firstName: 'Hand', lastName: 'Made', fiona_person_id: null }]
  ])
  const strapi = {
    findPersonById: id => people.get(Number(id)) || null,
    findManagedPeople: () => [...people.values()].filter(p => p.fiona_person_id)
  }
  const xapi = {
    listPersonAttachments: id => (id === 'fp-10' ? [attachment('headshot')] : []),
    listAccreditationAttachments: id => ({ 'acc-a': [attachment('showcase', { category: 2 })], 'acc-b': [], 'acc-c': [attachment('portrait')] }[id])
  }
  return { strapi, xapi }
}

describe('describePhotos', () => {
  it('lists the Fiona attachments of the person and of each accreditation, without tokens', async () => {
    const { strapi, xapi } = fakes()

    const result = await describePhotos({ personIds: [10], strapi, xapi, log: silent })

    expect(result.persons).toEqual([{
      personId: 10,
      name: 'Tõnis Pill',
      hasPicture: false,
      person: [{ category: 0, type: 'Image', title: 'headshot', fileName: 'headshot.jpg', createdOn: null }],
      accreditations: [
        { id: 'acc-a', attachments: [{ category: 2, type: 'Image', title: 'showcase', fileName: 'showcase.jpg', createdOn: null }] },
        { id: 'acc-b', attachments: [] }
      ]
    }])
    expect(JSON.stringify(result)).not.toMatch(/TOKEN/)
  })

  it('covers every person the sync manages when asked for all', async () => {
    const { strapi, xapi } = fakes()

    const result = await describePhotos({ all: true, strapi, xapi, log: silent })

    expect(result.persons.map(p => p.personId)).toEqual([10, 11])
    expect(result.persons[1].hasPicture).toBe(true)
  })

  it('skips persons the sync does not manage and says so', async () => {
    const { strapi, xapi } = fakes()

    const result = await describePhotos({ personIds: [12, 99], strapi, xapi, log: silent })

    expect(result.persons).toEqual([])
    expect(result.skipped).toEqual([{ personId: 12, reason: 'not managed by the Fiona sync' }, { personId: 99, reason: 'not found' }])
  })

  it('skips a person id Strapi cannot read and carries on with the rest', async () => {
    const { strapi, xapi } = fakes()
    const original = strapi.findPersonById
    strapi.findPersonById = (id) => { if (Number(id) === 7) throw new Error('500 Internal Server Error'); return original(id) }

    const result = await describePhotos({ personIds: [7, 11], strapi, xapi, log: silent })

    expect(result.skipped).toEqual([{ personId: 7, reason: 'could not be read: 500 Internal Server Error' }])
    expect(result.persons.map(p => p.personId)).toEqual([11])
  })

  it('keeps going when Fiona fails for one person and reports the error', async () => {
    const { strapi, xapi } = fakes()
    xapi.listPersonAttachments = (id) => { if (id === 'fp-10') throw new Error('Fiona down'); return [] }

    const result = await describePhotos({ personIds: [10, 11], strapi, xapi, log: silent })

    expect(result.persons.map(p => p.personId)).toEqual([11])
    expect(result.errors).toEqual([{ personId: 10, message: 'Fiona down' }])
  })

  it('refuses more than 100 persons in one call', async () => {
    const { strapi, xapi } = fakes()
    await expect(describePhotos({ personIds: Array.from({ length: 101 }, (_, i) => i + 1), strapi, xapi, log: silent })).rejects.toThrow(/at most 100/)
  })
})
