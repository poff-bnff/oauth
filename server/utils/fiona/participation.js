/**
 * fiona/participation.js
 *
 * Person.participationHistory (component person.participation-history, repeatable): one entry per festival edition with the
 * industry categories and the "Role @ Tallinn" person types the person had in THAT edition. Pure rules for writing it; no
 * network, no Strapi.
 *
 * Strapi 3 rules these functions are built on (docs: strapi3 component update semantics):
 *   - the array that is sent replaces the whole set of entries: an existing entry missing from it is DELETED, so every
 *     entry must be in it;
 *   - an entry sent with only its `id` is kept as it is (omitted fields and relations are retained); one sent with a list
 *     gets exactly that list, so a list that grows is sent whole (old ids and new ones);
 *   - an entry without an `id` is created.
 * That is why unchanged entries go out as `{ id }`, a changed one as `{ id, <the list that grew> }` and a new one in full.
 *
 * The lists of an entry are read from GET /people/:id. When they are not in the answer (the relations of a component not
 * expanded), nothing is combined or added: a list that is rewritten from nothing would wipe what the entry holds. The result
 * then carries a `problem` and no rows.
 */

const asList = value => (Array.isArray(value) ? value : [])
const idOf = value => (value && typeof value === 'object' ? value.id : value)
const idsOf = value => asList(value).map(item => Number(idOf(item))).filter(Number.isFinite)
const editionOf = (row) => {
  const id = Number(idOf(row?.festival_edition))
  return Number.isFinite(id) && id > 0 ? id : null
}
// an entry is readable when its edition (null = none chosen) and both lists are in the answer; a key that is missing altogether
// means Strapi did not expand it, and an entry whose edition is unknown could be the one for the edition we want
const readable = row => row !== null && typeof row === 'object' && 'festival_edition' in row && Array.isArray(row.industry_categories) && Array.isArray(row.industry_person_types)
const editionReadable = row => row !== null && typeof row === 'object' && 'festival_edition' in row
const unique = list => [...new Set(list)]

const CANNOT_READ = 'an entry of participationHistory cannot be read (its categories / person types are not in the answer of Strapi)'

/** An existing entry as it goes into the array: by id only, so Strapi keeps it as it is. */
const asSent = (row) => {
  if (row?.id !== undefined && row?.id !== null) return { id: row.id }
  return { festival_edition: editionOf(row), industry_categories: idsOf(row?.industry_categories), industry_person_types: idsOf(row?.industry_person_types) }
}

/**
 * The entries of the person that is merged away, carried over to the person that stays, per edition.
 * @returns {null | { rows: object[]|null, entriesAdded: number, entriesUpdated: number, links: number, problem: string|null }}
 *   null = nothing to carry; rows null with a problem = refused
 */
export function mergeParticipation (keepRows, removeRows) {
  const keep = asList(keepRows)
  const carried = new Map() // edition → { categories, types }
  for (const row of asList(removeRows)) {
    if (!editionReadable(row)) return { rows: null, entriesAdded: 0, entriesUpdated: 0, links: 0, problem: CANNOT_READ }
    const edition = editionOf(row)
    if (!edition) continue
    if (!readable(row)) return { rows: null, entriesAdded: 0, entriesUpdated: 0, links: 0, problem: CANNOT_READ }
    const have = carried.get(edition) || { categories: [], types: [] }
    have.categories = unique([...have.categories, ...idsOf(row.industry_categories)])
    have.types = unique([...have.types, ...idsOf(row.industry_person_types)])
    carried.set(edition, have)
  }
  if (!carried.size) return null
  if (!Array.isArray(keepRows) || !keep.every(editionReadable)) return { rows: null, entriesAdded: 0, entriesUpdated: 0, links: 0, problem: CANNOT_READ }

  const changes = new Map() // index of a kept entry → the lists that grew
  const created = []
  let links = 0
  for (const [edition, wanted] of carried) {
    const index = keep.findIndex(row => editionOf(row) === edition)
    if (index < 0) {
      created.push({ festival_edition: edition, industry_categories: wanted.categories, industry_person_types: wanted.types })
      links += wanted.categories.length + wanted.types.length
      continue
    }
    const row = keep[index]
    if (!readable(row)) return { rows: null, entriesAdded: 0, entriesUpdated: 0, links: 0, problem: CANNOT_READ }
    const categories = idsOf(row.industry_categories)
    const types = idsOf(row.industry_person_types)
    const newCategories = wanted.categories.filter(id => !categories.includes(id))
    const newTypes = wanted.types.filter(id => !types.includes(id))
    if (!newCategories.length && !newTypes.length) continue
    changes.set(index, {
      ...(newCategories.length ? { industry_categories: [...categories, ...newCategories] } : {}),
      ...(newTypes.length ? { industry_person_types: [...types, ...newTypes] } : {})
    })
    links += newCategories.length + newTypes.length
  }
  if (!changes.size && !created.length) return null

  const rows = [
    ...keep.map((row, index) => (changes.has(index) ? { id: row.id, ...changes.get(index) } : asSent(row))),
    ...created
  ]
  return { rows, entriesAdded: created.length, entriesUpdated: changes.size, links, problem: null }
}

/**
 * The industry categories the sync matched for an edition go into the entry of that edition (add only; the person types are
 * never touched). The entry is made when the person has none for the edition.
 * @returns {null | { rows: object[]|null, created: boolean, links: number, problem: string|null }} null = nothing to add
 */
export function addCategoriesToParticipation (rows, { editionId, categoryIds } = {}) {
  const edition = Number(editionId)
  const wanted = unique(idsOf(categoryIds))
  if (!Number.isFinite(edition) || edition <= 0 || !wanted.length) return null

  const keep = asList(rows)
  if (!Array.isArray(rows) || !keep.every(editionReadable)) return { rows: null, created: false, links: 0, problem: CANNOT_READ }
  const index = keep.findIndex(row => editionOf(row) === edition)
  if (index < 0) {
    return { rows: [...keep.map(asSent), { festival_edition: edition, industry_categories: wanted }], created: true, links: wanted.length, problem: null }
  }
  const row = keep[index]
  if (!Array.isArray(row.industry_categories)) return { rows: null, created: false, links: 0, problem: CANNOT_READ }
  const have = idsOf(row.industry_categories)
  const added = wanted.filter(id => !have.includes(id))
  if (!added.length) return null
  return {
    rows: keep.map((entry, position) => (position === index ? { id: entry.id, industry_categories: [...have, ...added] } : asSent(entry))),
    created: false,
    links: added.length,
    problem: null
  }
}

/** After a write: does the person hold everything that was sent (every entry still there, every sent list complete)? */
export function participationHolds (after, sent) {
  const actual = asList(after)
  return asList(sent).every((row) => {
    const hit = row.id !== undefined && row.id !== null
      ? actual.find(entry => Number(entry.id) === Number(row.id))
      : actual.find(entry => editionOf(entry) === editionOf(row) && containsAll(entry, row))
    if (!hit) return false
    return containsAll(hit, row)
  })
}

function containsAll (entry, wanted) {
  for (const field of ['industry_categories', 'industry_person_types']) {
    if (!Array.isArray(wanted[field])) continue
    const have = idsOf(entry[field])
    if (!idsOf(wanted[field]).every(id => have.includes(id))) return false
  }
  return true
}
