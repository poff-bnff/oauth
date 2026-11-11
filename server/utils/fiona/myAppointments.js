/**
 * fiona/myAppointments.js
 *
 * The appointments of one person, read live from the Fiona Publication API (nothing is stored in Strapi):
 * the person's accreditation card(s) → fiona/appointments.js → a name in an appointment becomes a link to the
 * profile page only when that person has a listed public profile.
 *
 * Fiona is asked at most once per three minutes per accreditation; when it fails, the last copy (up to 30
 * minutes old) is shown and marked `stale`; with no copy the answer is `{ ok: false, error: 'unavailable' }`.
 * A card that does not exist (an accreditation that is not published) is "nothing to show", not an error.
 * Strapi persons for the links are remembered for ten minutes; links are optional, so a Strapi failure only
 * leaves them out.
 */

import { normalizeAppointments, compareByTime } from './appointments.js'

export const CARD_TTL_MS = 3 * 60 * 1000
export const CARD_STALE_MS = 30 * 60 * 1000
export const PROFILE_TTL_MS = 10 * 60 * 1000
const MAX_CARDS = 500
const MAX_PROFILES = 5000

const asList = value => (Array.isArray(value) ? value : [])
const splitIds = value => String(value ?? '').split(',').map(id => id.trim()).filter(Boolean)

/** A small in-memory cache: `fresh` = younger than ttlMs, `stale` = younger than staleMs; the oldest entries go first. */
export function createCache ({ ttlMs, staleMs = ttlMs, maxEntries = MAX_CARDS, now = Date.now } = {}) {
  const entries = new Map()
  return {
    fresh (key) {
      const entry = entries.get(key)
      return entry && now() - entry.at < ttlMs ? entry : null
    },
    stale (key) {
      const entry = entries.get(key)
      return entry && now() - entry.at < staleMs ? entry : null
    },
    set (key, value) {
      entries.delete(key)
      entries.set(key, { value, at: now() })
      while (entries.size > maxEntries) entries.delete(entries.keys().next().value)
    },
    clear () { entries.clear() }
  }
}

const defaultCards = createCache({ ttlMs: CARD_TTL_MS, staleMs: CARD_STALE_MS, maxEntries: MAX_CARDS })
const defaultProfiles = createCache({ ttlMs: PROFILE_TTL_MS, maxEntries: MAX_PROFILES })

const isNotFound = err => err?.statusCode === 404 || err?.status === 404 || err?.response?.status === 404

async function readCard (id, { publication, cards, log }) {
  const fresh = cards.fresh(id)
  if (fresh) return { raw: fresh.value }
  try {
    const raw = (await publication.getRaw(`/accreditations/${encodeURIComponent(id)}`)) ?? null
    cards.set(id, raw)
    return { raw }
  } catch (err) {
    if (isNotFound(err)) { // not published in Fiona: nothing to show
      cards.set(id, null)
      return { raw: null }
    }
    log.warn?.(`[fiona appointments] accreditation ${id} could not be read: ${err?.message || err}`)
    const copy = cards.stale(id)
    return copy ? { raw: copy.value, stale: true } : { failed: true }
  }
}

/** The profile page slug of a person that is listed publicly (the rule of the industry site's person list), else null. */
function listedSlug (person) {
  if (!person) return null
  const listed = person.public !== false && person.show_in_cg_search === true && person.allowed_to_publish === true && asList(person.festival_editions).length > 0
  return listed ? String(person.slug_en ?? '').trim() || null : null
}

async function slugsOf (fionaPersonIds, { strapi, profiles, log }) {
  const slugs = new Map()
  const missing = []
  for (const id of fionaPersonIds) {
    const hit = profiles.fresh(id)
    if (hit) slugs.set(id, hit.value)
    else missing.push(id)
  }
  if (!missing.length) return slugs
  try {
    const found = new Map(asList(await strapi.findPeopleByFionaIds(missing)).map(person => [String(person.fiona_person_id), person]))
    for (const id of missing) {
      const slug = listedSlug(found.get(id))
      profiles.set(id, slug)
      slugs.set(id, slug)
    }
  } catch (err) {
    log.warn?.(`[fiona appointments] profile links skipped: ${err?.message || err}`)
  }
  return slugs
}

/**
 * @param {object} options
 * @param {object|null} options.person     the Strapi person (fiona_person_id, fiona_accreditation_id)
 * @param {{ getRaw: Function }} options.publication   Publication API client
 * @param {{ findPeopleByFionaIds: Function }} options.strapi   Strapi gateway
 * @param {string} [options.lang]          'en' (default) or 'et'
 * @returns {Promise<{ ok: boolean, programmes: object[], appointments: object[], stale?: true, partial?: true, error?: string }>}
 *   appointments sorted by start time; members are { name, role, isMe, slug }
 */
export async function appointmentsForPerson ({ person, publication, strapi, lang = 'en', cards = defaultCards, profiles = defaultProfiles, log = console } = {}) {
  const accreditationIds = splitIds(person?.fiona_accreditation_id)
  if (!accreditationIds.length) return { ok: true, programmes: [], appointments: [] }

  const results = []
  for (const id of accreditationIds) results.push(await readCard(id, { publication, cards, log }))
  const failed = results.filter(result => result.failed).length
  if (failed === results.length) return { ok: false, error: 'unavailable', programmes: [], appointments: [] }

  const options = { lang, myPersonId: person.fiona_person_id, myAccreditationIds: accreditationIds }
  const appointments = new Map()
  const programmes = new Map()
  for (const result of results) {
    if (result.failed) continue
    const normalized = normalizeAppointments(result.raw, options)
    for (const appointment of normalized.appointments) if (!appointments.has(appointment.id ?? appointment)) appointments.set(appointment.id ?? appointment, appointment)
    for (const programme of normalized.programmes) programmes.set(`${programme.id ?? programme.name}|${programme.role?.key ?? ''}`, programme)
  }
  const merged = [...appointments.values()].sort(compareByTime)

  const others = [...new Set(merged.flatMap(appointment => appointment.members.filter(member => !member.isMe && member.personId).map(member => member.personId)))]
  const slugs = others.length ? await slugsOf(others, { strapi, profiles, log }) : new Map()

  const response = {
    ok: true,
    programmes: [...programmes.values()],
    appointments: merged.map(appointment => ({
      ...appointment,
      members: appointment.members.map(member => ({ name: member.name, role: member.role, isMe: member.isMe, slug: (!member.isMe && slugs.get(member.personId)) || null }))
    }))
  }
  if (failed) response.partial = true
  if (results.some(result => result.stale)) response.stale = true
  return response
}

const REPORT_MAX_PERSONS = 5
const ACCREDITATION_ID = /^[A-Za-z0-9-]{3,64}$/

/**
 * Read-only check (mode `appointments` of the sync endpoint): for a few Strapi persons - or Fiona accreditation ids,
 * for someone the sync does not manage - exactly what the festival site would show them, read from Fiona now (fresh
 * caches, so nothing old is shown). Names of the people in the appointments are included: the endpoint is
 * secret-protected.
 * @param {{ personIds?: number[], accreditationIds?: string[], lang?: string, strapi: object, publication: object, log?: object }} options
 *   personIds + accreditationIds together: at most 5
 * @returns {Promise<{ persons: object[], skipped: object[] }>}
 */
export async function appointmentsReport ({ personIds = [], accreditationIds = [], lang = 'en', strapi, publication, log = console } = {}) {
  const ids = [...new Set((Array.isArray(personIds) ? personIds : []).map(Number).filter(id => Number.isInteger(id) && id > 0))]
  const accreditations = [...new Set((Array.isArray(accreditationIds) ? accreditationIds : []).map(id => String(id ?? '').trim()).filter(Boolean))]
  if (!ids.length && !accreditations.length) throw new Error('appointmentsReport needs personIds (Strapi person ids) or accreditationIds')
  if (ids.length + accreditations.length > REPORT_MAX_PERSONS) throw new Error(`appointmentsReport handles at most ${REPORT_MAX_PERSONS} persons and accreditations per call`)

  const fresh = () => ({
    cards: createCache({ ttlMs: CARD_TTL_MS, staleMs: CARD_STALE_MS }),
    profiles: createCache({ ttlMs: PROFILE_TTL_MS })
  })
  const result = { persons: [], skipped: [] }
  for (const id of ids) {
    let person
    try {
      person = await strapi.findPersonById(id)
    } catch (err) {
      result.skipped.push({ personId: id, reason: `could not be read: ${err?.message || err}` })
      continue
    }
    if (!person) { result.skipped.push({ personId: id, reason: 'not found' }); continue }
    if (!person.fiona_person_id) { result.skipped.push({ personId: id, reason: 'is not managed by the Fiona sync (no Fiona person id)' }); continue }

    const appointments = await appointmentsForPerson({ person, publication, strapi, lang, ...fresh(), log })
    result.persons.push({
      personId: id,
      name: person.firstNameLastName || [person.firstName, person.lastName].filter(Boolean).join(' '),
      accreditationIds: splitIds(person.fiona_accreditation_id),
      ...appointments
    })
  }
  for (const accreditationId of accreditations) {
    if (!ACCREDITATION_ID.test(accreditationId)) { result.skipped.push({ accreditationId, reason: 'is not a Fiona accreditation id' }); continue }
    // no Strapi person: the user is recognised among the members by the accreditation id alone
    const appointments = await appointmentsForPerson({ person: { fiona_person_id: null, fiona_accreditation_id: accreditationId }, publication, strapi, lang, ...fresh(), log })
    result.persons.push({ personId: null, name: `Fiona accreditation ${accreditationId}`, accreditationIds: [accreditationId], ...appointments })
  }
  return result
}
