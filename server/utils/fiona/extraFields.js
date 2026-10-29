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
