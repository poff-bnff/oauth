/**
 * fiona/extraFields.js
 *
 * Pure matching rules for the extra values the sync takes from Fiona (country, companies, Programme/category,
 * Current occupation). Nothing here talks to Fiona or Strapi; the sync passes the Strapi lists in.
 * Every rule only ADDS: what a person has in Strapi already is kept, and a value Strapi does not know is reported,
 * never invented (except organisations, which the sync creates; see sync.js).
 */

/** Case, accents, punctuation and spacing do not matter when two names are compared. */
export function normalizeName (value) {
  return String(value ?? '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
}

/** The names without empty ones and duplicates (first spelling wins), in order. */
export function uniqueNames (names) {
  const seen = new Set()
  const out = []
  for (const name of names || []) {
    const text = String(name ?? '').trim()
    const key = normalizeName(text)
    if (!key || seen.has(key)) continue
    seen.add(key)
    out.push(text)
  }
  return out
}

// what people type in the company field when they have none; such a word must never become an organisation
const PLACEHOLDER_COMPANIES = new Set([
  'n a', 'na', 'none', 'nothing', 'no', 'no company', 'not applicable', 'not available', 'unknown', 'tbd', 'private',
  'freelance', 'freelancer', 'freelancing', 'free lance', 'self employed', 'selfemployed', 'self employeed',
  'independent', 'independant', 'indipendent', 'independet', 'unemployed', 'student', 'retired'
])

export const isPlaceholderCompany = name => !normalizeName(name) || PLACEHOLDER_COMPANIES.has(normalizeName(name)) // "-" has no letters at all

/** "Producer, Production manager" → ["Producer", "Production manager"] (the field is free text). */
export function splitOccupations (text) {
  return uniqueNames(String(text ?? '').split(/[,;/\n]+/))
}

const idOf = value => Number((value && typeof value === 'object') ? value.id : value)

// the key a category label is compared by: every "Works in Progress ..." variant is the one Strapi category Works in Progress
const categoryKey = (label) => {
  const key = normalizeName(label)
  return key.startsWith('works in progress') ? 'works in progress' : key
}

/**
 * Programme / category labels from Fiona → ids of the Strapi industry categories.
 * @returns {{ ids: number[]|null, added: string[], unmatched: string[] }} ids = existing + new (null when nothing is new)
 */
export function planCategories ({ labels, strapiCategories, existingIds = [] }) {
  const byName = new Map((strapiCategories || []).map(category => [categoryKey(category.name), category]))
  const have = new Set(existingIds.map(Number))
  const ids = [...existingIds.map(Number)]
  const added = []
  const unmatched = []
  for (const label of uniqueNames(labels)) {
    const category = byName.get(categoryKey(label))
    if (!category) { unmatched.push(label); continue }
    if (have.has(Number(category.id))) continue
    have.add(Number(category.id))
    ids.push(Number(category.id))
    added.push(category.name)
  }
  return { ids: added.length ? ids : null, added, unmatched }
}

/**
 * Occupations from Fiona → rows for the person's ordered roles (`orderedRaF`), whitelist only: a role must exist in Strapi.
 * @param {{ occupations: string[], strapiRoles: {id:number, names:string[]}[], existingRows: object[] }} options
 * @returns {{ rows: object[]|null, added: string[], unmatched: string[] }} rows = all rows to send (existing ones with their id), null when nothing is new
 */
export function planRoles ({ occupations, strapiRoles, existingRows = [] }) {
  const byName = new Map()
  for (const role of strapiRoles || []) for (const name of role.names || []) if (normalizeName(name)) byName.set(normalizeName(name), role)
  const roleOf = row => (row.role_at_film === null || row.role_at_film === undefined ? null : idOf(row.role_at_film))
  const have = new Set(existingRows.map(roleOf).filter(id => id !== null))
  const rows = existingRows.map(row => ({ ...(row.id !== undefined ? { id: row.id } : {}), order: row.order, role_at_film: roleOf(row) }))
  let nextOrder = existingRows.reduce((max, row) => Math.max(max, Number(row.order) || 0), 0) + 1
  const added = []
  const unmatched = []
  for (const occupation of uniqueNames(occupations)) {
    // the whole text is a role: done. Otherwise "X and Y" / "X & Y" are separate roles.
    const whole = byName.get(normalizeName(occupation))
    const parts = whole ? [] : occupation.split(/\s+(?:and|&)\s+|\s*&\s*/i).map(part => part.trim()).filter(Boolean)
    const candidates = whole
      ? [{ text: occupation, role: whole }]
      : (parts.length > 1 ? parts.map(text => ({ text, role: byName.get(normalizeName(text)) })) : [{ text: occupation, role: undefined }])
    const anyMatched = candidates.some(candidate => candidate.role)
    if (!anyMatched) unmatched.push(occupation) // nothing in it is a role: report the text as it is
    for (const { text, role } of candidates) {
      if (!role) { if (anyMatched) unmatched.push(text); continue }
      if (have.has(Number(role.id))) continue
      have.add(Number(role.id))
      rows.push({ order: nextOrder++, role_at_film: Number(role.id) })
      added.push(role.names[0])
    }
  }
  return { rows: added.length ? rows : null, added, unmatched }
}

/** The person's country from Fiona → the Strapi country with the same English name. */
export function planCountry ({ country, strapiCountries }) {
  const name = country?.name
  if (!normalizeName(name)) return { id: null, unmatched: null }
  const hit = (strapiCountries || []).find(item => normalizeName(item.name_en) === normalizeName(name))
  return hit ? { id: Number(hit.id), unmatched: null } : { id: null, unmatched: name }
}

const programmeGuid = value => String(value ?? '').trim().toLowerCase()
const linkIdOf = item => (item !== null && typeof item === 'object' ? item.id : item)

/**
 * Which Strapi MeetingProgramme records a person is linked to: for every programme the person takes part in (and is not hidden for
 * meeting requests in), the record with the same Fiona programme id. The records are the ones Jaan creates by hand: the sync only LINKS,
 * it never creates one, so a programme without a record is only reported. When both the record and the card name a guestbook they must
 * be the same festival; a record without a guestbook matches any. Pure.
 * @param {{ wanted: Array<{ programmeId: string, programmeName?: string, guestbookId?: string }>, records: object[], current: Array<number|{ id: number }> }} options
 *   wanted = the programmes of the person's cards; records = Strapi MeetingProgramme records; current = the person's meeting_programmes now
 * @returns {{ ids: number[], linked: Array<{ id: number, name: string }>, unmatched: string[], changed: boolean }}
 *   ids ascending; changed = the set of records differs from `current` (an empty `ids` with a non-empty `current` clears the links)
 */
export function planMeetingProgrammes ({ wanted, records, current } = {}) {
  const list = Array.isArray(records) ? records : []
  const byId = new Map()
  const unmatched = []
  for (const entry of Array.isArray(wanted) ? wanted : []) {
    const programmeId = programmeGuid(entry?.programmeId)
    if (!programmeId) continue
    const guestbookId = programmeGuid(entry?.guestbookId)
    const record = list.find(item => programmeGuid(item?.programme_id) === programmeId && (!programmeGuid(item?.guestbook_id) || !guestbookId || programmeGuid(item.guestbook_id) === guestbookId))
    if (record) {
      byId.set(Number(record.id), { id: Number(record.id), name: String(record.programme_name ?? entry.programmeName ?? '').trim() })
    } else {
      const name = String(entry.programmeName ?? '').trim() || String(entry.programmeId).trim()
      if (!unmatched.includes(name)) unmatched.push(name)
    }
  }
  const ids = [...byId.keys()].sort((a, b) => a - b)
  const have = [...new Set((Array.isArray(current) ? current : []).map(linkIdOf).filter(id => id !== null && id !== undefined).map(Number))].sort((a, b) => a - b)
  return { ids, linked: ids.map(id => byId.get(id)), unmatched, changed: ids.join(',') !== have.join(',') }
}
