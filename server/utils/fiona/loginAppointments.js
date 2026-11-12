/**
 * fiona/loginAppointments.js
 *
 * The appointments of a logged-in user whose Strapi person carries no Fiona accreditation id (staff, organisers and
 * others the sync does not manage). Fiona has no search by e-mail, so the accreditation is found in two steps:
 *
 *   1. candidates: the persons of the Publication API list (`GET /persons`: id + fullName, cached for an hour) whose
 *      name is the name of a person of the login (the main account and its aliases);
 *   2. proof: a candidate is accepted ONLY when Fiona's own record says it is this login: the e-mail of the Fiona
 *      person is one of the login's e-mails, or the MyPoff user id Fiona keeps for the person is one of the login's
 *      user ids. A namesake never passes, so nobody sees the appointments of somebody else.
 *
 * The accreditations of an accepted person in an active guestbook (this festival) are then read like those of a synced
 * person (fiona/myAppointments.js). Nothing is written anywhere; names and e-mails are never logged.
 */

import { createCache, appointmentsForPerson, CARD_TTL_MS, CARD_STALE_MS, PROFILE_TTL_MS } from './myAppointments.js'
import { splitIds } from './desiredState.js'

export const PERSONS_TTL_MS = 60 * 60 * 1000
export const PERSONS_STALE_MS = 24 * 60 * 60 * 1000
export const LOOKUP_TTL_MS = 5 * 60 * 1000
const MAX_CANDIDATES = 5

const defaultPersons = createCache({ ttlMs: PERSONS_TTL_MS, staleMs: PERSONS_STALE_MS, maxEntries: 2 })
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

/** normalized name → Fiona person ids, from the Publication list of persons (cached; the old copy serves when Fiona fails). */
async function personIndex (publication, persons, log) {
  const fresh = persons.fresh('index')
  if (fresh) return fresh.value
  try {
    const index = new Map()
    for (const item of asList(await publication.getRaw('/persons'))) {
      const name = normalizeName(item?.fullName)
      if (!name || !item?.id) continue
      index.set(name, [...(index.get(name) || []), String(item.id)])
    }
    persons.set('index', index)
    return index
  } catch (err) {
    log.warn?.(`[fiona appointments] list of persons could not be read: ${err?.message || err}`)
    return persons.stale('index')?.value ?? null
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
 * @param {{ getRaw: Function }} options.publication   Publication API client (list of persons, one person)
 * @param {{ getPerson: Function, getMyPoffUserId: Function }} options.xapi   XAPI client (the proof)
 * @param {{ getActiveGuestbookIds: Function }} options.strapi
 * @returns {Promise<{ ok: true, fionaPersonId: string|null, accreditationIds: string[], trace: { names: number, candidates: object[] } } | { ok: false }>}
 *   ok false = Fiona could not be read well enough to tell (nothing is remembered then)
 */
export async function findAccreditationsForLogin ({ identity, publication, xapi, strapi, persons = defaultPersons, found = defaultFound, log = console } = {}) {
  const names = asList(identity?.names)
  if (!names.length) return NOT_FOUND({ names: 0, candidates: [] })

  const key = `login:${unique(asList(identity.userIds)).sort((a, b) => a - b).join(',') || asList(identity.emails).join(',')}`
  const known = found.fresh(key)
  if (known) return known.value

  const index = await personIndex(publication, persons, log)
  if (!index) return { ok: false }

  const candidates = unique(names.flatMap(name => index.get(name) || [])).slice(0, MAX_CANDIDATES)
  const proof = { emails: new Set(asList(identity.emails).map(lower).filter(Boolean)), userIds: new Set(asList(identity.userIds).map(String)), xapi, log }
  const verified = []
  const trace = { names: names.length, candidates: [] }
  let errored = false
  for (const id of candidates) {
    const { outcome, detail } = await verify(id, proof)
    trace.candidates.push(detail)
    if (outcome === 'yes') verified.push(id)
    else if (outcome === 'error') errored = true
  }

  let result = NOT_FOUND(trace)
  if (verified.length) {
    let activeGuestbooks
    try {
      activeGuestbooks = new Set(asList(await strapi.getActiveGuestbookIds()).map(String))
    } catch (err) {
      log.warn?.(`[fiona appointments] active guestbooks could not be read: ${err?.message || err}`)
      return { ok: false }
    }
    trace.activeGuestbooks = activeGuestbooks.size
    const accreditationIds = []
    let fionaPersonId = null
    for (const id of verified) {
      try {
        const detail = await publication.getRaw(`/persons/${encodeURIComponent(id)}`)
        const listed = asList(detail?.accreditations).filter(item => item?.id)
        trace.verified = trace.verified || []
        trace.verified.push({ accreditations: listed.map(item => ({ id: String(item.id), guestbook: String(item.guestbook?.id ?? ''), active: activeGuestbooks.has(String(item.guestbook?.id)) })) })
        const ids = listed.filter(item => activeGuestbooks.has(String(item.guestbook?.id))).map(item => String(item.id))
        if (ids.length && !fionaPersonId) fionaPersonId = id
        accreditationIds.push(...ids)
      } catch (err) {
        errored = true
        log.warn?.(`[fiona appointments] person ${id} could not be read: ${err?.message || err}`)
      }
    }
    if (!accreditationIds.length && errored) return { ok: false }
    result = { ok: true, fionaPersonId, accreditationIds: unique(accreditationIds), trace }
  } else if (errored) {
    return { ok: false }
  }

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
async function resolveAccreditations ({ user, loadPerson, publication, xapi, strapi, persons, found, log }) {
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
  const result = await findAccreditationsForLogin({ identity, publication, xapi, strapi, persons, found, log })
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
export async function appointmentsForUser ({ user, loadPerson, publication, xapi, strapi, lang = 'en', cards, profiles, persons, found, log = console } = {}) {
  const resolved = await resolveAccreditations({ user, loadPerson, publication, xapi, strapi, persons, found, log })
  return answerFor(resolved, { publication, strapi, lang, cards, profiles, log })
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
    persons: createCache({ ttlMs: PERSONS_TTL_MS, staleMs: PERSONS_STALE_MS, maxEntries: 2 }),
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

    const resolved = await resolveAccreditations({ user, loadPerson, publication, xapi, strapi, persons: caches.persons, found: caches.found, log })
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
