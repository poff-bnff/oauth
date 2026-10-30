/**
 * fiona/twinReport.js
 *
 * Read-only report: which persons the sync created have a "twin", a person with the same name that the sync does
 * not manage? The sync only recognises a person by its Fiona id, its MyPoff login or an exact e-mail, so a person
 * who was in Strapi before without (or with another) e-mail got a second record. Each pair is sorted into a tier:
 *   A = obvious: one older twin, no e-mail or the same one, nothing else involved (can be merged in bulk)
 *   B = look at it: another e-mail, several twins, an Eventival film person, or a twin newer than the copy
 *   C = never automatic: two different login users, two sync-managed records with the name, or the copy is used elsewhere
 * "Copy" is the sync-managed record, "twin" the other one. Nothing is written.
 */

import { normalizeName } from './extraFields.js'

const MIN_TERM_LENGTH = 3
const asList = value => (Array.isArray(value) ? value : [])
const sameEmail = (a, b) => String(a ?? '').trim().toLowerCase() === String(b ?? '').trim().toLowerCase()
const relationId = value => (value && typeof value === 'object') ? value.id : value
const label = refs => asList(refs).map(ref => `${ref.source} #${ref.id}`)

export const nameKey = person => normalizeName(person?.firstNameLastName || [person?.firstName, person?.lastName].filter(Boolean).join(' '))

const displayName = person => String(person?.firstNameLastName || [person?.firstName, person?.lastName].filter(Boolean).join(' ')).trim()

function longestToken (text) {
  const tokens = String(text ?? '').split(/[^\p{L}\p{N}]+/u).filter(token => token.length >= MIN_TERM_LENGTH)
  return tokens.sort((a, b) => b.length - a.length)[0] || null
}

/**
 * What to ask Strapi for to find the persons with this name: the longest word of the last name (of the whole name when
 * there is none), and its accent-free form too, because Strapi's "contains" does not see "o" in "õ".
 */
export function searchTerms (person) {
  const token = longestToken(person?.lastName) || longestToken(displayName(person))
  if (!token) return []
  const folded = normalizeName(token)
  return folded && folded !== token.toLowerCase() ? [token, folded] : [token]
}

/**
 * @param {{ copy: object, twin: object, twinCount: number, managedInGroup: number, copyRefs?: object[], twinRefs?: object[] }} options
 *   copy / twin are the slim records of this report ({ id, email, userId, remoteId })
 * @returns {{ tier: 'A'|'B'|'C', reasons: string[] }}
 */
export function classifyPair ({ copy, twin, twinCount, managedInGroup, copyRefs = [] }) {
  const blockers = []
  if (copy.userId && twin.userId && String(copy.userId) !== String(twin.userId)) blockers.push('both have a login user, and not the same one')
  if (managedInGroup > 1) blockers.push(`${managedInGroup} sync-managed records have this name`)
  if (copyRefs.length) {
    const shown = label(copyRefs).slice(0, 3)
    blockers.push(`the copy is used in ${shown.join(', ')}${copyRefs.length > shown.length ? ', …' : ''}`)
  }
  if (blockers.length) return { tier: 'C', reasons: blockers }

  const doubts = []
  if (twinCount > 1) doubts.push(`${twinCount} twins with this name`)
  if (twin.email && !sameEmail(twin.email, copy.email)) doubts.push('twin has another e-mail')
  if (twin.remoteId) doubts.push('twin is an Eventival film person')
  if (Number(twin.id) > Number(copy.id)) doubts.push('twin is newer than the copy')
  if (doubts.length) return { tier: 'B', reasons: doubts }

  return { tier: 'A', reasons: [twin.email ? 'one older twin with the same e-mail' : 'one older twin without e-mail'] }
}

function slimPerson (person, refs = []) {
  return {
    id: Number(person.id),
    name: displayName(person),
    email: String(person.eMail ?? '').trim() || null,
    fionaPersonId: person.fiona_person_id || null,
    remoteId: person.remoteId || null,
    userId: person.user ? Number(relationId(person.user)) : null,
    public: person.public ?? null,
    createdAt: person.created_at || null,
    updatedAt: person.updated_at || null,
    hasPicture: Boolean(person.picture),
    hasBio: Boolean(person.bio_en),
    editions: asList(person.festival_editions).length,
    organisations: asList(person.organisations).length,
    roles: asList(person.orderedRaF).length + asList(person.role_at_films).length,
    usedIn: label(refs)
  }
}

async function inPool (items, size, work) {
  const queue = [...items]
  await Promise.all(Array.from({ length: Math.min(size, queue.length) }, async () => {
    while (queue.length) await work(queue.shift())
  }))
}

/**
 * @param {{ strapi: object, log?: object, concurrency?: number }} options
 *   strapi needs findManagedPeople(), findPeopleByNameTerm(term) and findPersonReferences(ids) → { refs, covered, failed }
 */
export async function buildTwinReport ({ strapi, log = console, concurrency = 4 }) {
  const managed = asList(await strapi.findManagedPeople())

  // sync-managed persons by name: two of them with one name is a case of its own
  const groups = new Map() // nameKey → sync-managed persons
  let withoutName = 0
  for (const person of managed) {
    const key = nameKey(person)
    if (!key || !searchTerms(person).length) { withoutName++; continue }
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(person)
  }

  const twinsByName = new Map() // nameKey → persons with this name that the sync does not manage
  const lookupErrors = []
  await inPool([...groups.entries()], concurrency, async ([key, copies]) => {
    try {
      const found = new Map()
      for (const term of searchTerms(copies[0])) {
        for (const candidate of asList(await strapi.findPeopleByNameTerm(term))) found.set(Number(candidate.id), candidate)
      }
      twinsByName.set(key, [...found.values()].filter(candidate => nameKey(candidate) === key && !candidate.fiona_person_id))
    } catch (err) {
      lookupErrors.push({ name: displayName(copies[0]), error: err?.message || String(err) })
      log.warn?.(`[twins] ${displayName(copies[0])}: ${err?.message || err}`)
    }
  })

  const pending = []
  let withoutTwin = 0
  let groupCount = 0
  for (const [key, copies] of groups) {
    const twins = twinsByName.get(key)
    if (!twins) continue // the lookup failed: reported in lookupErrors
    if (!twins.length) { withoutTwin += copies.length; continue }
    groupCount++
    for (const copy of copies) for (const twin of twins) pending.push({ copy, twin, twinCount: twins.length, managedInGroup: copies.length })
  }

  let references = { refs: {}, covered: [], failed: [] }
  const ids = [...new Set(pending.flatMap(({ copy, twin }) => [Number(copy.id), Number(twin.id)]))]
  if (ids.length) {
    try {
      references = await strapi.findPersonReferences(ids)
    } catch (err) {
      references.failed.push({ source: 'all', error: err?.message || String(err) })
      log.warn?.(`[twins] references could not be read: ${err?.message || err}`)
    }
  }
  const refsOf = person => asList(references.refs?.[person.id])

  const tiers = { A: 0, B: 0, C: 0 }
  const pairs = pending.map(({ copy, twin, twinCount, managedInGroup }) => {
    const slimCopy = slimPerson(copy, refsOf(copy))
    const slimTwin = slimPerson(twin, refsOf(twin))
    const { tier, reasons } = classifyPair({ copy: slimCopy, twin: slimTwin, twinCount, managedInGroup, copyRefs: refsOf(copy), twinRefs: refsOf(twin) })
    tiers[tier]++
    return { tier, reasons, name: slimCopy.name, twinCount, copy: slimCopy, twin: slimTwin }
  }).sort((a, b) => a.tier.localeCompare(b.tier) || a.name.localeCompare(b.name) || a.copy.id - b.copy.id || a.twin.id - b.twin.id)

  log.info?.(`[twins] ${managed.length} sync-managed persons, ${groupCount} names with twins, ${pairs.length} pairs: A ${tiers.A}, B ${tiers.B}, C ${tiers.C}`)
  return {
    mode: 'twins',
    managed: managed.length,
    withoutName,
    withoutTwin,
    groups: groupCount,
    tiers,
    pairs,
    referenceCoverage: { covered: asList(references.covered), failed: asList(references.failed) },
    lookupErrors
  }
}
