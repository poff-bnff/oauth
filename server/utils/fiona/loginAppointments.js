/**
 * fiona/loginAppointments.js
 *
 * The appointments of a logged-in user whose Strapi person carries no Fiona accreditation id (staff, organisers and
 * others the sync does not manage). Fiona has no search by e-mail, so the accreditation is found in two steps:
 *
 *   1. candidates: the published accreditations of the active guestbooks (Publication API
 *      `GET /guestbooks/{id}/accreditations`: accreditation id + person id + full name, cached ten minutes) whose person has
 *      the name of a person of the login (the main account and its aliases). This list is current; the published person
 *      record (`GET /persons/{id}`) is a snapshot that can lack a new accreditation, so it is not used;
 *   2. proof: a person is accepted ONLY when Fiona's own record says it is this login: the e-mail of the Fiona person is one
 *      of the login's e-mails, or the MyPoff user id Fiona keeps for the person is one of the login's user ids. A namesake
 *      never passes, so nobody sees the appointments of somebody else.
 *
 * The accreditations of an accepted person in the active guestbooks (this festival) are then read like those of a synced
 * person (fiona/myAppointments.js). Nothing is written anywhere; names and e-mails are never logged.
 */

import { createCache, appointmentsForPerson, CARD_TTL_MS, CARD_STALE_MS, PROFILE_TTL_MS } from './myAppointments.js'
import { splitIds } from './desiredState.js'

export const INDEX_TTL_MS = 10 * 60 * 1000
export const INDEX_STALE_MS = 60 * 60 * 1000
export const LOOKUP_TTL_MS = 5 * 60 * 1000
const MAX_CANDIDATES = 5

const defaultIndex = createCache({ ttlMs: INDEX_TTL_MS, staleMs: INDEX_STALE_MS, maxEntries: 4 })
const defaultFound = createCache({ ttlMs: LOOKUP_TTL_MS, maxEntries: 2000 })

const asList = value => (Array.isArray(value) ? value : [])
const unique = list => [...new Set(list)]
const lower = value => String(value ?? '').trim().toLowerCase()

/** A name as it is compared: no case, accents or extra spaces. */
export function normalizeName (value) {
  return String(value ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim()
}

const nameOfPerson = person => (person !== null && typeof person === 'object'
  ? normalizeName(person.firstNameLastName || [person.firstName, person.lastName].filter(Boolean).join(' '))
  : '')
// Strapi gives a relation as an object or, for the alias accounts of a user, as a plain id
const personIdOf = person => (person !== null && typeof person === 'object' ? person.id : person)

/**
 * Who a login is: the ids, the e-mails and the (normalized) names of the main account and of its aliases.
 * A person that comes as an id only is loaded with `loadPerson`; one that cannot be loaded is left out.
 * @returns {Promise<{ userIds: number[], emails: string[], names: string[] }>}
 */
export async function loginIdentity (user, { loadPerson } = {}) {
  const accounts = [user, ...asList(user?.aliasUsers)].filter(Boolean)
  const names = []
  for (const account of accounts) {
    const person = account.person
    if (!person) continue
    let name = nameOfPerson(person)
    const personId = personIdOf(person)
    if (!name && personId && typeof loadPerson === 'function') {
      try {
        name = nameOfPerson(await loadPerson(personId))
      } catch (err) {
        name = ''
      }
    }
    if (name) names.push(name)
  }
  return {
    userIds: unique(accounts.map(account => Number(account.id)).filter(Number.isFinite)),
    emails: unique(accounts.map(account => lower(account.email)).filter(Boolean)),
    names: unique(names)
  }
}

const NOT_FOUND = trace => ({ ok: true, fionaPersonId: null, accreditationIds: [], trace })

/**
 * The published accreditations of the active guestbooks, by the normalized name of their person:
 * { byName: Map(name → [{ personId, accreditationId }]), listed: number }. Cached; the old copy serves when Fiona fails;
 * null when there is none.
 */
async function accreditationIndex (publication, guestbookIds, cache, log) {
  const key = `index:${[...guestbookIds].sort().join(',')}`
  const fresh = cache.fresh(key)
  if (fresh) return fresh.value
  try {
    const byName = new Map()
    let listed = 0
    for (const guestbookId of guestbookIds) {
      for (const item of asList(await publication.getRaw(`/guestbooks/${encodeURIComponent(guestbookId)}/accreditations`))) {
        const name = normalizeName(item?.person?.fullName)
        if (!name || !item?.id || !item?.person?.id) continue
        byName.set(name, [...(byName.get(name) || []), { personId: String(item.person.id), accreditationId: String(item.id) }])
        listed++
      }
    }
    const built = { byName, listed }
    cache.set(key, built)
    return built
  } catch (err) {
    log.warn?.(`[fiona appointments] list of accreditations could not be read: ${err?.message || err}`)
    return cache.stale(key)?.value ?? null
  }
}

/**
 * Is a Fiona person this login? outcome 'yes' when Fiona's own record says so, 'error' when Fiona could not be asked and
 * nothing proved it, else 'no'. `detail` says how each proof fared, without any value: email / myPoff is 'match',
 * 'differs', 'none' (Fiona has no value), 'error' or (myPoff) 'not-asked' (the e-mail settled it).
 */
async function verify (fionaPersonId, { emails, userIds, xapi, log }) {
  const detail = { email: 'none', myPoff: 'not-asked' }
  let errored = false
  try {
    const person = await xapi.getPerson(fionaPersonId)
    const email = lower(person?.email)
    if (email && emails.has(email)) {
      detail.email = 'match'
      return { outcome: 'yes', detail }
    }
    detail.email = email ? 'differs' : 'none'
  } catch (err) {
    errored = true
    detail.email = 'error'
    log.warn?.(`[fiona appointments] person ${fionaPersonId} could not be checked: ${err?.message || err}`)
  }
  try {
    const myPoffId = await xapi.getMyPoffUserId(fionaPersonId)
    if (myPoffId && userIds.has(String(myPoffId))) {
      detail.myPoff = 'match'
      return { outcome: 'yes', detail }
    }
    detail.myPoff = myPoffId ? 'differs' : 'none'
  } catch (err) {
    errored = true
    detail.myPoff = 'error'
  }
  return { outcome: errored ? 'error' : 'no', detail }
}

/**
 * @param {object} options
 * @param {{ userIds: number[], emails: string[], names: string[] }} options.identity   from loginIdentity
 * @param {{ getRaw: Function }} options.publication   Publication API client (the accreditation list of a guestbook)
 * @param {{ getPerson: Function, getMyPoffUserId: Function }} options.xapi   XAPI client (the proof)
 * @param {{ getActiveGuestbookIds: Function }} options.strapi
 * @returns {Promise<{ ok: true, fionaPersonId: string|null, accreditationIds: string[], trace: object } | { ok: false }>}
 *   ok false = Fiona could not be read well enough to tell (nothing is remembered then)
 */
export async function findAccreditationsForLogin ({ identity, publication, xapi, strapi, index = defaultIndex, found = defaultFound, log = console } = {}) {
  const names = asList(identity?.names)
  if (!names.length) return NOT_FOUND({ names: 0, candidates: [] })

  const key = `login:${unique(asList(identity.userIds)).sort((a, b) => a - b).join(',') || asList(identity.emails).join(',')}`
  const known = found.fresh(key)
  if (known) return known.value

  let guestbookIds
  try {
    guestbookIds = unique(asList(await strapi.getActiveGuestbookIds()).map(String))
  } catch (err) {
    log.warn?.(`[fiona appointments] active guestbooks could not be read: ${err?.message || err}`)
    return { ok: false }
  }
  if (!guestbookIds.length) return NOT_FOUND({ names: names.length, candidates: [], listed: 0, accreditations: 0 })

  const listing = await accreditationIndex(publication, guestbookIds, index, log)
  if (!listing) return { ok: false }

  const accreditationsOf = new Map() // Fiona person id → accreditation ids
  for (const name of names) {
    for (const entry of listing.byName.get(name) || []) {
      const have = accreditationsOf.get(entry.personId) || []
      if (!have.includes(entry.accreditationId)) have.push(entry.accreditationId)
      accreditationsOf.set(entry.personId, have)
    }
  }
  const candidates = [...accreditationsOf.keys()].slice(0, MAX_CANDIDATES)

  const proof = { emails: new Set(asList(identity.emails).map(lower).filter(Boolean)), userIds: new Set(asList(identity.userIds).map(String)), xapi, log }
  const trace = { names: names.length, candidates: [], listed: listing.listed, accreditations: 0 }
  const verified = []
  let errored = false
  for (const id of candidates) {
    const { outcome, detail } = await verify(id, proof)
    trace.candidates.push(detail)
    if (outcome === 'yes') verified.push(id)
    else if (outcome === 'error') errored = true
  }
  if (!verified.length && errored) return { ok: false }

  const accreditationIds = unique(verified.flatMap(id => accreditationsOf.get(id) || []))
  trace.accreditations = accreditationIds.length
  const result = { ok: true, fionaPersonId: verified[0] ?? null, accreditationIds, trace }
  found.set(key, result)
  return result
}

const EMPTY = () => ({ ok: true, programmes: [], appointments: [] })
const UNAVAILABLE = () => ({ ok: false, error: 'unavailable', programmes: [], appointments: [] })
const MAX_REPORT_USERS = 5

/**
 * Which Fiona accreditation(s) belong to a logged-in user: those of the Strapi person when it has them (the path of
 * synced persons), else the ones the login search finds (findAccreditationsForLogin).
 * @returns {Promise<{ ok: boolean, source: 'person'|'login', person: object|null, fionaPersonId: string|null, accreditationIds: string[], identity?: object }>}
 */
async function resolveAccreditations ({ user, loadPerson, publication, xapi, strapi, index, found, log }) {
  const loaded = new Map()
  const load = (id) => {
    if (!loaded.has(id)) loaded.set(id, Promise.resolve(loadPerson(id)))
    return loaded.get(id)
  }
  const personId = personIdOf(user?.person)
  const person = personId ? await load(personId) : null
  const own = splitIds(person?.fiona_accreditation_id)
  if (own.length) return { ok: true, source: 'person', person, fionaPersonId: person.fiona_person_id ?? null, accreditationIds: own }

  const identity = await loginIdentity(user, { loadPerson: load })
  const result = await findAccreditationsForLogin({ identity, publication, xapi, strapi, index, found, log })
  return {
    ok: result.ok,
    source: 'login',
    person: null,
    fionaPersonId: result.ok ? result.fionaPersonId : null,
    accreditationIds: result.ok ? result.accreditationIds : [],
    identity,
    search: result.ok ? result.trace : null
  }
}

/** The appointments for an accreditation resolved by resolveAccreditations. */
function answerFor (resolved, shared) {
  if (!resolved.ok) return UNAVAILABLE()
  if (!resolved.accreditationIds.length) return EMPTY()
  const person = resolved.person || { fiona_person_id: resolved.fionaPersonId, fiona_accreditation_id: resolved.accreditationIds.join(',') }
  return appointmentsForPerson({ person, ...shared })
}

/**
 * The appointments of a logged-in user: through the Fiona accreditation id(s) of the Strapi person when it has them,
 * else through the login (findAccreditationsForLogin).
 * @param {object} options
 * @param {object} options.user   the Strapi user: person, email, aliasUsers (each with email and person)
 * @param {Function} options.loadPerson   id → the full Strapi person
 * @returns {Promise<object>} the answer of appointmentsForPerson
 */
export async function appointmentsForUser ({ user, loadPerson, publication, xapi, strapi, lang = 'en', cards, profiles, index, found, log = console } = {}) {
  const resolved = await resolveAccreditations({ user, loadPerson, publication, xapi, strapi, index, found, log })
  return answerFor(resolved, { publication, strapi, lang, cards, profiles, log })
}

/** appointmentsForUser with caches of its own: a probe reads the published card from Fiona every time instead of sharing hunt's live caches. */
export function appointmentsForUserFresh ({ user, loadPerson, publication, xapi, strapi, lang = 'en', log = console } = {}) {
  return appointmentsForUser({
    user,
    loadPerson,
    publication,
    xapi,
    strapi,
    lang,
    log,
    cards: createCache({ ttlMs: CARD_TTL_MS, staleMs: CARD_STALE_MS }),
    profiles: createCache({ ttlMs: PROFILE_TTL_MS }),
    index: createCache({ ttlMs: INDEX_TTL_MS, staleMs: INDEX_STALE_MS, maxEntries: 4 }),
    found: createCache({ ttlMs: LOOKUP_TTL_MS, maxEntries: 50 })
  })
}

/**
 * Read-only check (mode `appointments` with `userIds` of the sync endpoint): for a few Strapi users - any account of a
 * login, the main account is used - how the Fiona accreditation is found and what the festival site would show,
 * read from Fiona now (fresh caches). The e-mails and names of the login are not in the report, only how many there are.
 * @returns {Promise<{ persons: object[], skipped: object[] }>}
 */
export async function loginAppointmentsReport ({ userIds = [], lang = 'en', loadUser, loadPerson, publication, xapi, strapi, log = console } = {}) {
  const ids = [...new Set((Array.isArray(userIds) ? userIds : []).map(Number).filter(id => Number.isInteger(id) && id > 0))]
  if (!ids.length) throw new Error('loginAppointmentsReport needs userIds (Strapi user ids)')
  if (ids.length > MAX_REPORT_USERS) throw new Error(`loginAppointmentsReport handles at most ${MAX_REPORT_USERS} users per call`)

  const caches = {
    cards: createCache({ ttlMs: CARD_TTL_MS, staleMs: CARD_STALE_MS }),
    profiles: createCache({ ttlMs: PROFILE_TTL_MS }),
    index: createCache({ ttlMs: INDEX_TTL_MS, staleMs: INDEX_STALE_MS, maxEntries: 4 }),
    found: createCache({ ttlMs: LOOKUP_TTL_MS, maxEntries: 50 })
  }
  const result = { persons: [], skipped: [] }
  for (const userId of ids) {
    let user
    try {
      user = await loadUser(userId)
    } catch (err) {
      result.skipped.push({ userId, reason: `could not be read: ${err?.message || err}` })
      continue
    }
    if (!user) { result.skipped.push({ userId, reason: 'not found' }); continue }

    const resolved = await resolveAccreditations({ user, loadPerson, publication, xapi, strapi, index: caches.index, found: caches.found, log })
    const appointments = await answerFor(resolved, { publication, strapi, lang, cards: caches.cards, profiles: caches.profiles, log })
    result.persons.push({
      userId,
      source: resolved.source,
      fionaPersonId: resolved.fionaPersonId,
      accreditationIds: resolved.accreditationIds,
      ...(resolved.search ? { search: resolved.search } : {}),
      ...(resolved.identity ? { identity: { accounts: resolved.identity.userIds.length, emails: resolved.identity.emails.length, names: resolved.identity.names.length } } : {}),
      ...appointments
    })
  }
  return result
}
