/**
 * fiona/personCredits.js
 *
 * Point the credits of one person to another person (the first step of merging a person that is credited in films,
 * courses, projects, teams, ...). Pure: it reads an entry as the REST route returns it and says what to PUT back.
 *
 * Strapi 3 writes components by row (see memory strapi3-component-update-semantics):
 *  - a row sent WITH its id is updated in place, and what is left out of it keeps its value
 *  - a row that is left out of a list is deleted, a row without an id is created anew
 *  - a component key that is left out is not touched at all
 * So the patch holds, for every list it touches, EVERY row with its id (in the original order), and the new person only
 * on the rows that change; the lists and fields that do not change are not sent. The parent component's id is sent too.
 *
 * Which fields of which model hold a person is spelled out in SCHEMAS (from the model files of web2021/strapi). An entry
 * that is not described there, or fields that are not described, are never touched: the caller treats a reference the
 * scan found but this module did not is a reason to skip the pair.
 */

const relationId = value => (value && typeof value === 'object' ? value.id : value)
const idsIn = value => (Array.isArray(value) ? value.flatMap(idsIn) : [Number(relationId(value))].filter(id => Number.isFinite(id) && id > 0))
const hasId = row => row && row.id !== undefined && row.id !== null

// node = { keys: person fields of this level (a relation, or a list of them), children: { component field: node } }
const CREDITS = { children: { rolePerson: { keys: ['person'] } } } // film.credentials-new
const PERSON_WITH_FILMOGRAPHY = { keys: ['person'], children: { filmography: { children: { film: { keys: ['person_of_role'] } } } } }
const SCHEMAS = {
  film: { children: { credentials: CREDITS } },
  course: { children: { credentials: CREDITS } },
  'course-event': { children: { credentials: CREDITS } },
  'industry-project': { children: { teamCredentials: CREDITS } },
  'dis-camp-project': { children: { teamCredentials: CREDITS } },
  team: { children: { subTeam: { children: { teamMember: { keys: ['person'] }, juryMember: { keys: ['person'] } } } } },
  'industry-person': PERSON_WITH_FILMOGRAPHY,
  'dis-camp-person': PERSON_WITH_FILMOGRAPHY,
  filmography: { keys: ['person'] },
  client: { keys: ['client_person'] },
  awarding: { keys: ['person'] },
  'dis-camp-article': { keys: ['people'] },
  'industry-article': { keys: ['people'] }
}
export const CREDIT_SOURCES = Object.keys(SCHEMAS)

// what a credit says apart from who it is for: two rows that say the same are one credit
const IGNORED = new Set(['id', '_id', 'order', '__component', 'created_at', 'updated_at'])
const normal = value => (value === null || value === undefined || value === '' ? '' : (typeof value === 'object' ? JSON.stringify(Array.isArray(value) ? value.map(relationId) : relationId(value)) : String(value)))
function sameContent (a, b, keys) {
  for (const name of new Set([...Object.keys(a), ...Object.keys(b)])) {
    if (IGNORED.has(name) || keys.includes(name)) continue
    if (normal(a[name]) !== normal(b[name])) return false
  }
  return true
}

const fail = reason => ({ ok: false, reason })
const where = (rowPath, key) => [rowPath, key === 'person' && rowPath ? '' : key].filter(Boolean).join('.')

/** One row (or the entry itself): its person fields, then the components below it. */
function patchRow (row, node, fromId, toId, rowPath) {
  const patch = {}
  const changes = []
  let dropped = 0
  for (const key of node.keys || []) {
    const ids = idsIn(row[key])
    if (!ids.includes(fromId)) continue
    patch[key] = Array.isArray(row[key]) ? [...new Set(ids.map(id => (id === fromId ? toId : id)))] : toId
    if (Array.isArray(row[key]) && ids.includes(toId)) dropped++ // the list had the other person already: one entry less
    changes.push(`${where(rowPath, key)}: person ${fromId} → ${toId}`)
  }
  for (const [field, child] of Object.entries(node.children || {})) {
    const value = row[field]
    if (value === null || value === undefined) continue
    const path = rowPath ? `${rowPath}.${field}` : field
    const result = Array.isArray(value) ? patchRows(value, child, fromId, toId, path) : patchOne(value, child, fromId, toId, path)
    if (result.ok === false) return result
    if (!result.changed) continue
    patch[field] = result.patch
    changes.push(...result.changes)
    dropped += result.dropped
  }
  return { ok: true, changed: Object.keys(patch).length > 0, patch, changes, dropped }
}

/** A single component: sent with its own id. */
function patchOne (component, node, fromId, toId, path) {
  const result = patchRow(component, node, fromId, toId, path)
  if (result.ok === false || !result.changed) return result
  if (!hasId(component)) return fail(`${path} has no id, so it cannot be updated in place`)
  return { ...result, patch: { id: component.id, ...result.patch } }
}

/** A list of component rows: every row goes back with its id; a row that repeats a credit the other person holds is left out. */
function patchRows (rows, node, fromId, toId, path) {
  const results = []
  for (const row of rows) {
    const result = patchRow(row, node, fromId, toId, hasId(row) ? `${path} #${row.id}` : path)
    if (result.ok === false) return result
    results.push(result)
  }
  if (!results.some(result => result.changed)) return { ok: true, changed: false }
  const missing = rows.findIndex(row => !hasId(row))
  if (missing !== -1) return fail(`${path} has a row without an id (row ${missing + 1}), so the list cannot be sent back without deleting and recreating it`)

  // two rows that say the same for the same person are one credit: only for rows with a single person field
  const key = (node.keys || []).length === 1 ? node.keys[0] : null
  const holds = rows.map(row => (key && !Array.isArray(row[key]) ? idsIn(row[key])[0] ?? null : null))
  const out = []
  const changes = []
  let dropped = 0
  rows.forEach((row, index) => {
    const result = results[index]
    if (key && result.patch[key] === toId && holds[index] === fromId) {
      const twin = rows.findIndex((other, otherIndex) => otherIndex !== index && holds[otherIndex] === toId && sameContent(row, other, node.keys))
      if (twin !== -1) {
        dropped++
        changes.push(`${path} #${row.id}: dropped, #${rows[twin].id} holds the same credit for ${toId}`)
        return
      }
      holds[index] = toId // the next identical row is a duplicate of this one
    }
    out.push({ id: row.id, ...result.patch })
    changes.push(...result.changes)
    dropped += result.dropped
  })
  return { ok: true, changed: true, patch: out, changes, dropped }
}

/** How many credits name this person in the places this module knows (a list of people counts once), to check a write. */
export function creditCount (source, entry, personId) {
  const count = (row, node) => {
    let total = 0
    for (const key of node.keys || []) if (idsIn(row[key]).includes(Number(personId))) total++
    for (const [field, child] of Object.entries(node.children || {})) {
      const value = row[field]
      if (Array.isArray(value)) total += value.reduce((sum, item) => sum + count(item, child), 0)
      else if (value && typeof value === 'object') total += count(value, child)
    }
    return total
  }
  return SCHEMAS[source] ? count(entry || {}, SCHEMAS[source]) : 0
}

/**
 * What to PUT so that the credits of `fromId` in `entry` go to `toId`.
 * @param {{ source: string, entry: object, fromId: number, toId: number }} options
 * @returns {{ ok: true, found: boolean, patch: object|null, changes: string[], dropped: number } | { ok: false, supported?: false, reason: string }}
 */
export function creditsPatch ({ source, entry, fromId, toId }) {
  const node = SCHEMAS[source]
  if (!node) return { ok: false, supported: false, reason: `credits in ${source} are not moved by this tool` }
  const result = patchRow(entry || {}, node, Number(fromId), Number(toId), '')
  if (result.ok === false) return result
  if (!result.changed) return { ok: true, found: false, patch: null, changes: [], dropped: 0 }
  return { ok: true, found: true, patch: result.patch, changes: result.changes, dropped: result.dropped }
}
