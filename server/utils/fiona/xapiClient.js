/**
 * fiona/xapiClient.js
 *
 * Fiona XAPI access for the sync, behind the small client interface that
 * `fiona/sync.js` expects. A Publication API client can implement the same
 * interface later (see the plan for POFF-166).
 *
 * The normalisers are pure and exported for tests; `createXapiClient()`
 * receives `fetch` and the API key so this module has no Nuxt globals.
 */

const DEFAULT_BASE_URL = 'https://poff-xapi.fiona-app.com/api'
const DEFAULT_PROVIDER_NAME = 'MyPoff'
const RETRYABLE_CODES = new Set(['EAI_AGAIN', 'ENOTFOUND', 'ECONNRESET', 'ETIMEDOUT'])

const pick = (obj, ...keys) => {
  for (const key of keys) {
    if (obj && obj[key] !== undefined && obj[key] !== null) return obj[key]
  }
  return null
}

const text = value => (value === null || value === undefined) ? null : String(value)

/** XAPI badge (PascalCase, sometimes camelCase) → { badgeId, badgeName, statusText } */
export function normalizeBadges (raw) {
  if (!Array.isArray(raw)) return []
  const badges = []
  for (const item of raw) {
    const guestbookBadge = pick(item, 'GuestbookBadge', 'guestbookBadge') || {}
    const status = pick(item, 'Status', 'status') || {}
    const badgeId = text(pick(guestbookBadge, 'Id', 'id'))
    const badgeName = text(pick(guestbookBadge, 'Description', 'description'))
    if (!badgeId && !badgeName) continue
    badges.push({
      badgeId: badgeId || '',
      badgeName: badgeName || '',
      statusText: text(pick(status, 'Description', 'description')) || ''
    })
  }
  return badges
}

/** XAPI accreditation detail → { personId, noPublicationOfContactDetails, films } */
export function normalizeAccreditation (raw) {
  const person = pick(raw, 'Person', 'person') || {}
  const films = pick(raw, 'Films', 'films') || []
  return {
    personId: text(pick(person, 'Id', 'id')),
    noPublicationOfContactDetails: pick(raw, 'NoPublicationOfContactDetails', 'noPublicationOfContactDetails') === true,
    films: (Array.isArray(films) ? films : []).map(film => ({
      id: text(pick(film, 'Id', 'id')),
      title: text(pick(film, 'Description', 'description'))
    }))
  }
}

function communicationValue (items, wantedType) {
  if (!Array.isArray(items)) return null
  const ofType = items.filter((item) => {
    const type = pick(item, 'type', 'Type') || {}
    const description = text(pick(type, 'description', 'Description', 'Key', 'key')) || ''
    return description.toLowerCase() === wantedType
  })
  const preferred = ofType.find(item => pick(item, 'isDefault', 'IsDefault') === true) || ofType[0]
  return preferred ? text(pick(preferred, 'value', 'Value')) : null
}

/** XAPI person + communication items → { firstName, lastName, email, phone, bio, country } */
export function normalizePerson (person, communicationItems) {
  const contactDetails = pick(person, 'ContactDetails', 'contactDetails')
  const address = pick(person, 'address', 'Address') || {}
  const country = pick(address, 'country', 'Country')
  return {
    firstName: text(pick(person, 'firstName', 'FirstName')),
    lastName: text(pick(person, 'lastName', 'LastName')),
    email: communicationValue(communicationItems, 'email') || communicationValue(contactDetails, 'email'),
    phone: communicationValue(communicationItems, 'phone') || communicationValue(contactDetails, 'phone'),
    bio: text(pick(person, 'biography', 'Biography')),
    country: country
      ? { id: text(pick(country, 'id', 'Id', 'Key', 'key')), name: text(pick(country, 'description', 'Description')) }
      : null
  }
}

/** Attachments → token of the best image (publication media first), or null */
export function pickPhotoAttachment (attachments) {
  if (!Array.isArray(attachments)) return null
  const isImage = (item) => {
    const contentType = pick(item, 'contentType', 'ContentType') || {}
    const description = text(pick(contentType, 'description', 'Description')) || ''
    return description.toLowerCase().includes('image')
  }
  const category = item => Number(pick(item, 'category', 'Category'))
  const candidate = attachments.find(item => category(item) === 2 && isImage(item)) ||
    attachments.find(item => category(item) === 0 && isImage(item))
  return candidate ? text(pick(candidate, 'value', 'Value')) : null
}

/**
 * Create the XAPI client.
 * @param {object} options
 * @param {Function} options.fetch        `$fetch`-compatible function (url, options) → parsed body
 * @param {string}   options.apiKey       X-ApiKey value
 * @param {string}   [options.baseUrl]
 * @param {string}   [options.providerName]  external-authentication provider name (MyPoff)
 * @param {object}   [options.log]
 * @param {Function} [options.download]   (url) → Promise<Buffer>, defaults to global fetch
 * @param {Function} [options.delay]      (ms) → Promise
 */
export function createXapiClient ({
  fetch,
  apiKey,
  baseUrl = DEFAULT_BASE_URL,
  providerName = DEFAULT_PROVIDER_NAME,
  log = console,
  download,
  delay = ms => new Promise(resolve => setTimeout(resolve, ms))
}) {
  if (typeof fetch !== 'function') throw new Error('createXapiClient: fetch is required')

  async function get (path) {
    const url = `${baseUrl}${path}`
    let lastError
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        return await fetch(url, { headers: { 'X-ApiKey': apiKey } })
      } catch (err) {
        lastError = err
        const retryable = RETRYABLE_CODES.has(err?.code) || err?.name === 'FetchError' || (err?.statusCode >= 500)
        if (!retryable || attempt === 3) throw err
        log.warn?.(`[fiona] ${path} attempt ${attempt} failed (${err.message}), retrying`)
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

  return {
    /** All guestbooks visible to this API key (diagnostics). */
    async listGuestbooks () {
      const list = await get('/guestbooks')
      return (Array.isArray(list) ? list : [])
        .map(item => ({ id: text(pick(item, 'id', 'Id')), name: text(pick(item, 'description', 'Description', 'name', 'Name')) }))
        .filter(item => item.id)
    },

    async listGuestbookBadges (guestbookId) {
      const guestbook = await get(`/guestbook/${encodeURIComponent(guestbookId)}`)
      const badges = pick(guestbook, 'badges', 'Badges') || []
      return badges.map(badge => ({ id: text(pick(badge, 'id', 'Id')), name: text(pick(badge, 'description', 'Description')) }))
    },

    async listAccreditations (guestbookId) {
      const list = await get(`/guestbook/${encodeURIComponent(guestbookId)}/accreditations`)
      return (Array.isArray(list) ? list : []).map(item => ({
        id: text(pick(item, 'id', 'Id')),
        updatedOn: text(pick(item, 'updatedOn', 'UpdatedOn'))
      })).filter(item => item.id)
    },

    async getAccreditationBadges (accreditationId) {
      return normalizeBadges(await get(`/accreditation/${encodeURIComponent(accreditationId)}/badges`))
    },

    async getAccreditation (accreditationId) {
      return normalizeAccreditation(await get(`/accreditation/${encodeURIComponent(accreditationId)}`))
    },

    async getPerson (personId) {
      const [person, communicationItems] = await Promise.all([
        get(`/person/${encodeURIComponent(personId)}`),
        get(`/person/${encodeURIComponent(personId)}/communicationItems`).catch(() => null)
      ])
      return normalizePerson(person, communicationItems)
    },

    async getMyPoffUserId (personId) {
      try {
        const auths = await get(`/person/${encodeURIComponent(personId)}/${providerName}/externalauthentications`)
        const first = Array.isArray(auths) ? auths[0] : null
        return first ? text(pick(first, 'externalIdentification', 'ExternalIdentification')) : null
      } catch (err) {
        log.warn?.(`[fiona] external authentications for person ${personId} unavailable: ${err.message}`)
        return null
      }
    },

    async getPersonPhoto (personId) {
      const attachments = await get(`/person/${encodeURIComponent(personId)}/attachments`)
      const token = pickPhotoAttachment(attachments)
      if (!token) return null
      const urlResult = await get(`/attachment/${encodeURIComponent(token)}`)
      const url = typeof urlResult === 'string' ? urlResult : pick(urlResult, 'accessUrl', 'url')
      if (!url) return null
      return { buffer: await downloadBuffer(url), filename: `fiona-person-${personId}.jpg` }
    }
  }
}
