/**
 * fiona/publicationClient.js
 *
 * Fiona Publication API access for the sync. Implements the same client
 * interface as fiona/xapiClient.js (so fiona/sync.js does not care which one
 * it talks to) and adds the mutations feed plus the lookups the incremental
 * mode needs.
 *
 * One `/accreditations/{id}` call carries the badges with their statuses,
 * the person (names, contact details, biography, MyPoff link, photos) and
 * the films, so records are memoised per client instance and served to
 * getAccreditationBadges / getAccreditation / getPerson / getMyPoffUserId /
 * getPersonPhoto from that single fetch.
 *
 * Only records published in Fiona are visible here. The normalisers are pure
 * and exported for tests; `createPublicationClient()` receives `fetch` and
 * the key so this module has no Nuxt globals.
 */

const DEFAULT_BASE_URL = 'https://poff-online-api.fiona-online.net/v1'
const RETRYABLE_CODES = new Set(['EAI_AGAIN', 'ENOTFOUND', 'ECONNRESET', 'ETIMEDOUT'])

const text = value => (value === null || value === undefined) ? null : String(value)
const lower = value => String(value ?? '').toLowerCase()

/** English text of a Fiona lookup value, falling back to any translation, then the key. */
export function lookupText (lookup) {
  if (!lookup || typeof lookup !== 'object') return text(lookup)
  const translations = Array.isArray(lookup.translations) ? lookup.translations : []
  const en = translations.find(t => lower(t.language) === 'en')
  return text(en?.text ?? translations[0]?.text ?? lookup.key)
}

function contactValue (contactDetails, wantedType) {
  if (!Array.isArray(contactDetails)) return null
  const hit = contactDetails.find(item => lower(item?.type?.key) === lower(wantedType) && item?.value)
  return hit ? text(hit.value) : null
}

function textOfType (texts, typeKey) {
  if (!Array.isArray(texts)) return null
  const hit = texts.find(item => lower(item?.type?.key) === lower(typeKey))
  if (!hit) return null
  const translations = Array.isArray(hit.translations) ? hit.translations : []
  const en = translations.find(t => lower(t.language) === 'en')
  const legacy = Array.isArray(hit.html) ? hit.html[0]?.html : null
  return text(en?.html ?? translations[0]?.html ?? legacy)
}

function imagePublications (list) {
  return (Array.isArray(list) ? list : []).filter(item => lower(item?.type?.key) === 'image' && item?.value)
}

function pickPhotoToken (person, record) {
  const images = [...imagePublications(person?.publications), ...imagePublications(record?.publications)]
  const favouriteId = person?.favoriteImageAttachmentId || record?.favoriteImageAttachmentId
  const favourite = favouriteId ? images.find(item => item.id === favouriteId) : null
  return text(favourite?.value ?? record?.image?.value ?? images[0]?.value)
}

function normalizePublishedPerson (person, record) {
  const country = person?.address?.country
  return {
    id: text(person?.id),
    firstName: text(person?.firstName),
    lastName: text(person?.lastName),
    email: contactValue(person?.contactDetails, 'Email'),
    phone: contactValue(person?.contactDetails, 'Phone'),
    bio: textOfType(person?.texts, 'biography'),
    country: country ? { id: text(country.key), name: lookupText(country) } : null,
    externalAccountId: text(person?.externalAccountId) || null,
    photoToken: pickPhotoToken(person, record)
  }
}

/** Publication API `/accreditations/{id}` record → the shape the sync works with. */
export function normalizeAccreditationRecord (raw) {
  const badges = (Array.isArray(raw?.badges) ? raw.badges : []).map(badge => ({
    badgeId: text(badge?.guestbookBadge?.id) || '',
    badgeName: text(badge?.guestbookBadge?.description) || '',
    statusText: lookupText(badge?.status) || '',
    statusKey: text(badge?.status?.key) || ''
  }))
  const films = (Array.isArray(raw?.films) ? raw.films : []).map((film) => {
    const roles = Array.isArray(film?.roles) ? film.roles : (film?.roles ? [film.roles] : [])
    return {
      id: text(film?.id),
      editionId: text(film?.edition?.id),
      title: text(film?.fullPreferredTitle ?? film?.sortedTitle),
      roles: roles.map(role => text(role?.key ?? role)).filter(Boolean)
    }
  })
  return {
    id: text(raw?.id),
    guestbookId: text(raw?.guestbook?.id),
    personId: text(raw?.person?.id),
    badges,
    noPublicationOfContactDetails: raw?.noPublicationOfContactDetails === true,
    films,
    person: normalizePublishedPerson(raw?.person, raw)
  }
}

/** Date or ISO string → Fiona's yyyyMMddTHHmmssSSSZ (UTC). */
export function toFionaTimestamp (value) {
  const date = value instanceof Date ? value : new Date(value)
  return date.toISOString().replace(/[-:]/g, '').replace('.', '') // 2026-09-01T00:00:00.000Z → 20260901T000000000Z
}

/**
 * @param {object} options
 * @param {Function} options.fetch     `$fetch`-compatible (url, options) → parsed body
 * @param {string}   options.apiKey    Publication API key (`apikey` header)
 * @param {string}   [options.baseUrl]
 * @param {object}   [options.log]
 * @param {Function} [options.download] (url) → Promise<Buffer>
 * @param {Function} [options.delay]
 */
export function createPublicationClient ({
  fetch,
  apiKey,
  baseUrl = DEFAULT_BASE_URL,
  log = console,
  download,
  delay = ms => new Promise(resolve => setTimeout(resolve, ms))
}) {
  if (typeof fetch !== 'function') throw new Error('createPublicationClient: fetch is required')

  const records = new Map() // accreditationId → normalised record
  const persons = new Map() // personId → normalised person (from the last record seen)

  async function get (path) {
    const url = `${baseUrl}${path}`
    let lastError
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        return await fetch(url, { headers: { apikey: apiKey } })
      } catch (err) {
        lastError = err
        const retryable = RETRYABLE_CODES.has(err?.code) || err?.name === 'FetchError' || (err?.statusCode >= 500)
        if (!retryable || attempt === 3) throw err
        log.warn?.(`[fiona-publication] ${path} attempt ${attempt} failed (${err.message}), retrying`)
        await delay(500 * attempt)
      }
    }
    throw lastError
  }

  const downloadBuffer = download || (async (url) => {
    const response = await globalThis.fetch(url)
    if (!response.ok) throw new Error(`download failed: HTTP ${response.status}`)
    return Buffer.from(await response.arrayBuffer())
  })

  async function getAccreditationRecord (accreditationId) {
    const id = String(accreditationId)
    if (!records.has(id)) {
      const record = normalizeAccreditationRecord(await get(`/accreditations/${encodeURIComponent(id)}`))
      records.set(id, record)
      if (record.person?.id) persons.set(record.person.id, record.person)
    }
    return records.get(id)
  }

  async function getPersonAccreditations (personId) {
    const person = await get(`/persons/${encodeURIComponent(personId)}`)
    return (Array.isArray(person?.accreditations) ? person.accreditations : [])
      .map(item => ({ id: text(item?.id), guestbookId: text(item?.guestbook?.id) }))
      .filter(item => item.id)
  }

  async function getPerson (personId) {
    const id = String(personId)
    if (persons.has(id)) return persons.get(id)
    for (const accreditation of await getPersonAccreditations(id)) {
      const record = await getAccreditationRecord(accreditation.id)
      if (record.person?.id === id) return record.person
    }
    throw new Error(`person ${id} has no published accreditation`)
  }

  return {
    resetCache () { records.clear(); persons.clear() },

    async listGuestbooks () {
      const list = await get('/guestbooks')
      return (Array.isArray(list) ? list : [])
        .map(item => ({ id: text(item?.id), name: text(item?.name ?? item?.description) }))
        .filter(item => item.id)
    },

    async listGuestbookBadges (guestbookId) {
      const guestbook = await get(`/guestbooks/${encodeURIComponent(guestbookId)}`)
      return (Array.isArray(guestbook?.badges) ? guestbook.badges : [])
        .map(badge => ({ id: text(badge?.id), name: text(badge?.description ?? badge?.name) }))
        .filter(badge => badge.id)
    },

    async listAccreditations (guestbookId) {
      const list = await get(`/guestbooks/${encodeURIComponent(guestbookId)}/accreditations`)
      return (Array.isArray(list) ? list : [])
        .map(item => ({ id: text(item?.id), personId: text(item?.person?.id) }))
        .filter(item => item.id)
    },

    getAccreditationRecord,

    async getAccreditationBadges (accreditationId) {
      return (await getAccreditationRecord(accreditationId)).badges
    },

    async getAccreditation (accreditationId) {
      const record = await getAccreditationRecord(accreditationId)
      return {
        personId: record.personId,
        guestbookId: record.guestbookId,
        noPublicationOfContactDetails: record.noPublicationOfContactDetails,
        films: record.films
      }
    },

    getPerson,

    async getMyPoffUserId (personId) {
      return (await getPerson(personId)).externalAccountId || null
    },

    async getPersonPhoto (personId) {
      const person = await getPerson(personId)
      if (!person.photoToken) return null
      const result = await get(`/attachments/${encodeURIComponent(person.photoToken)}`)
      const url = typeof result === 'string' ? result.trim() : (result?.accessUrl || result?.url)
      if (!url) return null
      return { buffer: await downloadBuffer(url), filename: `fiona-person-${personId}.jpg` }
    },

    async listMutations (since) {
      const list = await get(`/mutations/${toFionaTimestamp(since)}`)
      return (Array.isArray(list) ? list : []).map(item => ({
        entityName: text(item?.entityName),
        entityId: text(item?.entityId),
        mutation: Number(item?.mutation),
        entityUpdatedOn: text(item?.entityUpdatedOn)
      }))
    },

    async getAccreditationBadgeRecord (badgeId) {
      const badge = await get(`/accreditationbadges/${encodeURIComponent(badgeId)}`)
      return { accreditationId: text(badge?.accreditation?.id) }
    },

    getPersonAccreditations
  }
}
