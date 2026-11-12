import { describe, it, expect } from 'vitest'
import { programmeReport } from '../server/utils/fiona/programmeReport.js'

const silent = { info () {}, warn () {}, error () {} }

const person = (id, over = {}) => ({
  id,
  firstName: 'Ann',
  lastName: `Star${id}`,
  firstNameLastName: `Ann Star${id}`,
  fiona_person_id: `fp-${id}`,
  fiona_accreditation_id: `acc-${id}`,
  festival_editions: [{ id: 59 }, { id: 114 }],
  ...over
})

const chip = (key, label, optionKey = label.toLowerCase().replace(/\s+/g, '-')) => ({
  key,
  optionKey,
  translations: [{ language: 'et', label: `${label} (et)` }, { language: 'en', label }]
})
const INDUSTRY = 'accreditation-general-industry-category'
const DISCAMP = 'accreditation-festival-attendance-discovery-campus-programme'

const card = (guestbookId, options = []) => ({ id: 'x', guestbook: { id: guestbookId }, person: { id: 'p' }, customFieldOptions: options })

const categories = [{ id: 7, name: 'Black Nights Stars' }, { id: 8, name: 'Discovery Campus' }, { id: 9, name: 'Works in Progress' }]

function run ({ people = [], cards = {}, active = ['gb-2026'], editions = [], strapiCategories = categories, concurrency } = {}) {
  const asked = []
  const strapi = {
    findPeopleByEdition: (editionId) => { asked.push(editionId); return Promise.resolve(people) },
    listIndustryCategories: () => Promise.resolve(strapiCategories),
    listEditionsWithGuestbook: () => Promise.resolve(editions),
    getActiveGuestbookIds: () => Promise.resolve(active)
  }
  const publication = {
    getRaw: (path) => {
      const id = decodeURIComponent(path.replace('/accreditations/', ''))
      const hit = cards[id]
      if (hit instanceof Error) return Promise.reject(hit)
      if (!hit) { const err = new Error('not found'); err.statusCode = 404; return Promise.reject(err) }
      return Promise.resolve(hit)
    }
  }
  return programmeReport({ strapi, publication, editionId: 114, log: silent, concurrency }).then(result => ({ ...result, asked }))
}

describe('programmeReport: the Programme/category chips of the 2026 card of everyone with an edition', () => {
  it('asks Strapi for the persons of the given edition', async () => {
    const result = await run({ people: [] })
    expect(result.asked).toEqual([114])
    expect(result.rows).toEqual([])
  })

  it('gives the raw English labels of both chip fields and the Strapi categories they match', async () => {
    const result = await run({
      people: [person(1)],
      cards: { 'acc-1': card('gb-2026', [chip(INDUSTRY, 'Black Nights Stars'), chip(DISCAMP, 'Discovery Campus'), chip('accreditation-general-fields-of-work', 'Directing')]) }
    })

    expect(result.rows).toHaveLength(1)
    expect(result.rows[0]).toMatchObject({
      strapiPersonId: 1,
      name: 'Ann Star1',
      fionaPersonId: 'fp-1',
      fionaAccreditationIds: ['acc-1'],
      guestbookIds: ['gb-2026'],
      programmeLabels: ['Black Nights Stars', 'Discovery Campus'],
      matchedCategoryIds: [7, 8],
      matchedCategoryNames: ['Black Nights Stars', 'Discovery Campus'],
      unmatchedLabels: [],
      status: 'ok'
    })
  })

  it('lists a label without a Strapi category as unmatched, and a Works in Progress variant as the one Strapi category', async () => {
    const result = await run({
      people: [person(1)],
      cards: { 'acc-1': card('gb-2026', [chip(INDUSTRY, 'Works in Progress Series'), chip(INDUSTRY, 'TV Beats')]) }
    })

    expect(result.rows[0].matchedCategoryNames).toEqual(['Works in Progress'])
    expect(result.rows[0].unmatchedLabels).toEqual(['TV Beats'])
    expect(result.rows[0].programmeLabels).toEqual(['Works in Progress Series', 'TV Beats'])
  })

  it('takes the labels only from cards of an active guestbook; other cards are reported apart', async () => {
    const result = await run({
      people: [person(1, { fiona_accreditation_id: 'acc-new,acc-old' })],
      cards: {
        'acc-new': card('gb-2026', [chip(INDUSTRY, 'Discovery Campus')]),
        'acc-old': card('gb-2024', [chip(INDUSTRY, 'Black Nights Stars')])
      },
      editions: [{ id: 110, name: '30th BNFF', guestbookId: 'gb-2026' }, { id: 81, name: '28th BNFF', guestbookId: 'gb-2024' }]
    })

    const row = result.rows[0]
    expect(row.programmeLabels).toEqual(['Discovery Campus'])
    expect(row.matchedCategoryNames).toEqual(['Discovery Campus'])
    expect(row.otherCardLabels).toEqual(['Black Nights Stars'])
    expect(row.guestbookIds).toEqual(['gb-2026', 'gb-2024'])
    expect(row.guestbookEditions).toEqual(['110 30th BNFF', '81 28th BNFF'])
    expect(row.activeGuestbook).toBe(true)
  })

  it('marks a person without a Fiona link, a card that is not published, and a card that failed', async () => {
    const result = await run({
      people: [
        person(1, { fiona_person_id: null, fiona_accreditation_id: null }),
        person(2, { fiona_accreditation_id: null }),
        person(3),
        person(4)
      ],
      cards: { 'acc-4': new Error('socket hang up') }
    })

    const byId = Object.fromEntries(result.rows.map(row => [row.strapiPersonId, row]))
    expect(byId[1].status).toBe('no-fiona-link')
    expect(byId[2].status).toBe('no-accreditation-id')
    expect(byId[3].status).toBe('card-not-published')
    expect(byId[4].status).toBe('error: socket hang up')
    expect(byId[3].programmeLabels).toEqual([])
    expect(result.summary.statuses).toEqual({ 'no-fiona-link': 1, 'no-accreditation-id': 1, 'card-not-published': 1, 'error: socket hang up': 1 })
  })

  it('counts, per label, the persons that carry it and the Strapi category it matches, in the summary', async () => {
    const result = await run({
      people: [person(1), person(2), person(3)],
      cards: {
        'acc-1': card('gb-2026', [chip(INDUSTRY, 'Black Nights Stars')]),
        'acc-2': card('gb-2026', [chip(INDUSTRY, 'Black Nights Stars'), chip(DISCAMP, 'TV Beats')]),
        'acc-3': card('gb-2026', [])
      }
    })

    expect(result.summary.labels).toEqual([
      { label: 'Black Nights Stars', persons: 2, strapiCategory: { id: 7, name: 'Black Nights Stars' } },
      { label: 'TV Beats', persons: 1, strapiCategory: null }
    ])
    expect(result.summary.persons).toBe(3)
    expect(result.summary.withLabels).toBe(2)
  })

  it('shows every chip field of the active cards in the summary, so a label under another key is found, and the star-like labels', async () => {
    const result = await run({
      people: [person(1), person(2)],
      cards: {
        'acc-1': card('gb-2026', [chip('accreditation-general-gm-tag', 'Black Nights Stars')]),
        'acc-2': card('gb-2026', [chip('accreditation-general-gm-tag', 'Black Nights Stars'), chip('accreditation-general-fields-of-work', 'Directing')])
      }
    })

    expect(result.summary.optionKeys).toEqual([
      { key: 'accreditation-general-fields-of-work', labels: [{ label: 'Directing', persons: 1 }] },
      { key: 'accreditation-general-gm-tag', labels: [{ label: 'Black Nights Stars', persons: 2 }] }
    ])
    expect(result.summary.starLike).toEqual([{ key: 'accreditation-general-gm-tag', label: 'Black Nights Stars', persons: 2 }])
  })

  it('lists the Strapi industry categories and the active guestbooks in the summary', async () => {
    const result = await run({ people: [], active: ['gb-2026'] })
    expect(result.summary.strapiCategories).toEqual(categories)
    expect(result.summary.activeGuestbookIds).toEqual(['gb-2026'])
  })

  it('reads every card once and keeps the order of the persons whatever order the cards come back in', async () => {
    const people = [1, 2, 3, 4, 5, 6].map(id => person(id))
    const cards = Object.fromEntries(people.map(p => [`acc-${p.id}`, card('gb-2026', [chip(INDUSTRY, 'Discovery Campus')])]))
    const result = await run({ people, cards, concurrency: 3 })

    expect(result.rows.map(row => row.strapiPersonId)).toEqual([1, 2, 3, 4, 5, 6])
  })
})
