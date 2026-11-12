/**
 * fiona/programmeReport.js
 *
 * Read-only report: for everyone in Strapi who carries a festival edition (Industry@Tallinn & Baltic Event 2026 = 114), the
 * Programme/category chips of their 2026 Fiona accreditation card, and the Strapi industry categories those labels match with
 * the sync's own name matching (planCategories). It answers "which programme is this person in this year?" per person, so the
 * year-tagged participation history (Person.participationHistory) can be filled from Fiona instead of by hand.
 *
 * One row per person; the cards are read from the Publication API (`GET /accreditations/{id}`), the ids come from the person's
 * `fiona_accreditation_id` in Strapi. A card counts as "2026" when its guestbook is an active one (the guestbooks of the editions
 * the sync works on now); labels of cards of other guestbooks are kept apart (`otherCardLabels`) and never mixed in. Persons
 * without a Fiona link get a row with a status and no labels. Nothing is written anywhere.
 *
 * No Nuxt auto-imports here so the module is unit-testable.
 */

import { splitIds } from './desiredState.js'
import { normalizeAccreditationRecord } from './publicationClient.js'
import { planCategories, uniqueNames } from './extraFields.js'

const DEFAULT_CONCURRENCY = 4
const STAR_LIKE = /\bstars?\b/i

const asList = value => (Array.isArray(value) ? value : [])
const text = value => (value === null || value === undefined ? '' : String(value).trim())
const nameOf = person => text(person.firstNameLastName || [person.firstName, person.lastName].filter(Boolean).join(' '))

/** Runs `task(item, index)` over the items with at most `limit` at a time; results keep the order of the items. */
async function mapLimited (items, limit, task) {
  const results = new Array(items.length)
  let next = 0
  const worker = async () => {
    while (next < items.length) {
      const index = next++
      results[index] = await task(items[index], index)
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker))
  return results
}

/** Every chip of a raw card: { key, label } with the English label (else the first one, else the option key). */
function cardOptions (raw) {
  return asList(raw?.customFieldOptions).map((option) => {
    const translations = asList(option?.translations)
    const en = translations.find(item => String(item?.language ?? '').toLowerCase() === 'en')
    return { key: text(option?.key), label: text(en?.label ?? translations[0]?.label ?? option?.optionKey) }
  }).filter(option => option.key && option.label)
}

/** Reads the cards of one person. */
async function readCards (person, publication, activeGuestbooks) {
  const cards = []
  const problems = []
  for (const id of splitIds(person.fiona_accreditation_id)) {
    try {
      const raw = await publication.getRaw(`/accreditations/${encodeURIComponent(id)}`)
      const record = normalizeAccreditationRecord(raw)
      cards.push({ id, guestbookId: record.guestbookId || '', labels: record.categories, options: cardOptions(raw), active: activeGuestbooks.has(record.guestbookId) })
    } catch (err) {
      const notPublished = err?.statusCode === 404 || err?.status === 404 || err?.response?.status === 404
      problems.push(notPublished ? 'card-not-published' : `error: ${err?.message || err}`)
    }
  }
  return { cards, problems }
}

/**
 * @param {{ strapi: object, publication: { getRaw: Function }, editionId?: number, concurrency?: number, log?: object }} options
 *   strapi: findPeopleByEdition, listIndustryCategories, listEditionsWithGuestbook, getActiveGuestbookIds
 * @returns {Promise<{ summary: object, rows: object[] }>}
 */
export async function programmeReport ({ strapi, publication, editionId = 114, concurrency = DEFAULT_CONCURRENCY, log = console } = {}) {
  const [people, strapiCategories, editions, activeIds] = await Promise.all([
    strapi.findPeopleByEdition(editionId),
    strapi.listIndustryCategories(),
    strapi.listEditionsWithGuestbook(),
    strapi.getActiveGuestbookIds()
  ])
  const activeGuestbooks = new Set(asList(activeIds).map(String))
  const editionsOfGuestbook = new Map()
  for (const edition of asList(editions)) {
    const key = text(edition.guestbookId)
    if (!key) continue
    editionsOfGuestbook.set(key, [...(editionsOfGuestbook.get(key) || []), `${edition.id} ${text(edition.name)}`.trim()])
  }
  log.info?.(`[programmeReport] edition ${editionId}: ${people.length} persons, ${activeGuestbooks.size} active guestbooks`)

  let done = 0
  const rows = await mapLimited(people, concurrency, async (person) => {
    const fionaPersonId = text(person.fiona_person_id) || null
    const accreditationIds = splitIds(person.fiona_accreditation_id)
    const base = { strapiPersonId: person.id, name: nameOf(person), fionaPersonId, fionaAccreditationIds: accreditationIds }
    const empty = { guestbookIds: [], guestbookEditions: [], activeGuestbook: false, programmeLabels: [], matchedCategoryIds: [], matchedCategoryNames: [], unmatchedLabels: [], otherCardLabels: [], cardProblems: [], options: [] }

    if (!fionaPersonId) return { ...base, ...empty, status: 'no-fiona-link' }
    if (!accreditationIds.length) return { ...base, ...empty, status: 'no-accreditation-id' }

    const { cards, problems } = await readCards(person, publication, activeGuestbooks)
    if (++done % 100 === 0) log.info?.(`[programmeReport] ${done}/${people.length} persons read`)

    const guestbookIds = uniqueNames(cards.map(card => card.guestbookId))
    const labels = uniqueNames(cards.filter(card => card.active).flatMap(card => card.labels))
    const plan = planCategories({ labels, strapiCategories, existingIds: [] })
    const matchedIds = plan.ids ?? []
    return {
      ...base,
      guestbookIds,
      guestbookEditions: uniqueNames(guestbookIds.flatMap(id => editionsOfGuestbook.get(id) || [])),
      activeGuestbook: cards.some(card => card.active),
      programmeLabels: labels,
      matchedCategoryIds: matchedIds,
      matchedCategoryNames: plan.added,
      unmatchedLabels: plan.unmatched,
      otherCardLabels: uniqueNames(cards.filter(card => !card.active).flatMap(card => card.labels)),
      cardProblems: problems,
      options: cards.filter(card => card.active).flatMap(card => card.options),
      status: cards.length ? 'ok' : (problems[0] || 'card-not-published')
    }
  })

  return { summary: summarise({ rows, strapiCategories, activeGuestbooks }), rows: rows.map(({ options, ...row }) => row) }
}

function summarise ({ rows, strapiCategories, activeGuestbooks }) {
  const statuses = {}
  const labelPersons = new Map() // label → persons
  const optionPersons = new Map() // key → Map(label → persons)
  for (const row of rows) {
    statuses[row.status] = (statuses[row.status] || 0) + 1
    for (const label of row.programmeLabels) labelPersons.set(label, (labelPersons.get(label) || 0) + 1)
    const seen = new Set()
    for (const { key, label } of row.options) {
      const id = `${key}\u0000${label}`
      if (seen.has(id)) continue
      seen.add(id)
      const labels = optionPersons.get(key) || new Map()
      labels.set(label, (labels.get(label) || 0) + 1)
      optionPersons.set(key, labels)
    }
  }

  const byCount = (a, b) => b.persons - a.persons || a.label.localeCompare(b.label)
  const labels = [...labelPersons].map(([label, persons]) => {
    const match = planCategories({ labels: [label], strapiCategories, existingIds: [] })
    const category = match.ids ? { id: match.ids[0], name: match.added[0] } : null
    return { label, persons, strapiCategory: category }
  }).sort(byCount)

  const optionKeys = [...optionPersons]
    .map(([key, byLabel]) => ({ key, labels: [...byLabel].map(([label, persons]) => ({ label, persons })).sort(byCount) }))
    .sort((a, b) => a.key.localeCompare(b.key))
  const starLike = optionKeys.flatMap(({ key, labels: list }) => list.filter(item => STAR_LIKE.test(item.label)).map(item => ({ key, label: item.label, persons: item.persons })))

  return {
    persons: rows.length,
    withLabels: rows.filter(row => row.programmeLabels.length).length,
    statuses,
    labels,
    optionKeys,
    starLike,
    strapiCategories,
    activeGuestbookIds: [...activeGuestbooks]
  }
}
