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

/** XAPI accreditation detail → { personId, guestbookId, noPublicationOfContactDetails, films } */
export function normalizeAccreditation (raw) {
  const person = pick(raw, 'Person', 'person') || {}
  const guestbook = pick(raw, 'Guestbook', 'guestbook') || {}
  const films = pick(raw, 'Films', 'films') || []
  return {
    personId: text(pick(person, 'Id', 'id')),
    guestbookId: text(pick(guestbook, 'Id', 'id')),
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
 * Attachment list of a person or an accreditation (published or not) →
 * [{ id, category, type, contentType, title, fileName, createdOn, token }].
 * type is Image / Document / URL / Memo; contentType is the label staff give in Fiona (Headshot, Showcase, ...).
 * The token is only for downloading and never shown in diagnostics.
 */
export function normalizeAttachments (raw) {
  if (!Array.isArray(raw)) return []
  return raw.map((item) => {
    const type = pick(item, 'type', 'Type') || {}
    const contentType = pick(item, 'contentType', 'ContentType')
    return {
      id: text(pick(item, 'id', 'Id')),
      category: Number(pick(item, 'category', 'Category')),
      type: text(pick(type, 'description', 'Description')),
      contentType: typeof contentType === 'string'
        ? (contentType.trim() || null)
        : (contentType ? text(pick(contentType, 'description', 'Description', 'key', 'Key', 'name', 'Name')) : null),
      title: text(pick(item, 'title', 'Title')),
      fileName: text(pick(item, 'originalFileName', 'OriginalFileName')),
      createdOn: text(pick(item, 'createdOn', 'CreatedOn')),
      token: text(pick(item, 'value', 'Value'))
    }
  })
}

/**
 * The Headshot to use when nothing is published: an attachment of type Image whose content type is "Headshot"
 * (whatever its title or file name). Several: the default one, the image Fiona marks with the star (favouriteIds are
 * the ids of those); when no default is detected among them, the LATEST. otherFiles counts the other distinct files
 * and choice says 'only', 'default' or 'latest', so a dry run can show how the choice was made. Documents, links,
 * notes and every other content type never count.
 */
export function pickHeadshot (attachments, favouriteIds = []) {
  const headshots = (Array.isArray(attachments) ? attachments : []).filter(item =>
    String(item?.type || '').toLowerCase().includes('image') &&
    String(item?.contentType || '').trim().toLowerCase() === 'headshot' &&
    item?.token
  )
  if (!headshots.length) return null
  const favourites = new Set((Array.isArray(favouriteIds) ? favouriteIds : []).filter(Boolean).map(String))
  const defaults = headshots.filter(item => item.id && favourites.has(String(item.id)))
  const pool = defaults.length ? defaults : headshots
  const chosen = [...pool].sort((a, b) => String(b.createdOn || '').localeCompare(String(a.createdOn || '')))[0]
  const label = item => item.fileName || item.id
  const otherFiles = new Set(headshots.map(label).filter(name => name !== label(chosen))).size
  return { ...chosen, otherFiles, choice: otherFiles === 0 ? 'only' : (defaults.length ? 'default' : 'latest') }
}

const MAX_BIOGRAPHY_CHARS = 20000

/** Fiona file tokens are base64 of a binary header starting with "S3" followed by the bucket and the key. */
function looksLikeFileToken (value) {
  const raw = String(value ?? '')
  if (raw.length < 40 || /\s/.test(raw)) return false
  try {
    return Buffer.from(raw, 'base64').subarray(0, 2).toString('latin1') === 'S3'
  } catch (err) {
    return false
  }
}

/**
 * The biography to use when nothing is published: a Memo attachment of the accreditation whose content type is
 * "Biography", published (category 2) or not. Several: the latest. Documents, links and every other content type
 * never count.
 */
export function pickBiography (attachments) {
  const memos = (Array.isArray(attachments) ? attachments : []).filter(item =>
    String(item?.type || '').toLowerCase().includes('memo') &&
    String(item?.contentType || '').trim().toLowerCase() === 'biography' &&
    item?.token
  )
  if (!memos.length) return null
  return [...memos].sort((a, b) => String(b.createdOn || '').localeCompare(String(a.createdOn || '')))[0]
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

  async function listPersonAttachments (personId) {
    return normalizeAttachments(await get(`/person/${encodeURIComponent(personId)}/attachments`))
  }

  async function listAccreditationAttachments (accreditationId) {
    return normalizeAttachments(await get(`/accreditation/${encodeURIComponent(accreditationId)}/attachments`))
  }

  return {
    /** The untouched JSON of any path (field diagnostic). */
    getRaw: path => get(path),

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

    listPersonAttachments,
    listAccreditationAttachments,

    /** The Headshot of a person (own attachments and its accreditations'), published or not; null when there is none. */
    async getUnpublishedHeadshot (personId, accreditationIds = [], { download = true } = {}) {
      const lists = [await listPersonAttachments(personId)]
      for (const id of accreditationIds) lists.push(await listAccreditationAttachments(id))
      // the default (starred) image is named on the person and on the accreditation; a failed lookup just means
      // "no default detected", the latest headshot is used then
      const favouriteIds = []
      for (const path of [`/person/${encodeURIComponent(personId)}`, ...accreditationIds.map(id => `/accreditation/${encodeURIComponent(id)}`)]) {
        try {
          const detail = await get(path)
          const favourite = pick(detail, 'FavoriteImageAttachment', 'favoriteImageAttachment')
          const id = text(pick(favourite || {}, 'Id', 'id')) || text(pick(detail, 'FavoriteImageAttachmentId', 'favoriteImageAttachmentId'))
          if (id) favouriteIds.push(id)
        } catch (err) {
          log.warn?.(`[fiona] default image lookup ${path} failed: ${err?.message || err}`)
        }
      }
      const picked = pickHeadshot(lists.flat(), favouriteIds)
      if (!picked) return null
      if (!download) return { buffer: null, filename: `fiona-person-${personId}.jpg`, fileName: picked.fileName, otherFiles: picked.otherFiles, choice: picked.choice }
      const urlResult = await get(`/attachment/url?token=${encodeURIComponent(picked.token)}`)
      const url = typeof urlResult === 'string' ? urlResult : pick(urlResult, 'accessUrl', 'AccessUrl', 'url', 'Url')
      if (!url) return null
      return { buffer: await downloadBuffer(url), filename: `fiona-person-${personId}.jpg`, fileName: picked.fileName, otherFiles: picked.otherFiles, choice: picked.choice }
    },

    /**
     * The biography of a person from the Biography memo on its accreditation card(s), published or not; null when
     * there is none. The text is inline in the attachment, or a file to download (both are handled).
     * Only the accreditation card is read, never the person card.
     */
    async getUnpublishedBiography (accreditationIds = []) {
      const lists = []
      for (const id of accreditationIds) lists.push(await listAccreditationAttachments(id))
      const picked = pickBiography(lists.flat())
      if (!picked) return null
      let raw = picked.token
      if (looksLikeFileToken(raw)) {
        const urlResult = await get(`/attachment/url?token=${encodeURIComponent(raw)}`)
        const url = typeof urlResult === 'string' ? urlResult : pick(urlResult, 'accessUrl', 'AccessUrl', 'url', 'Url')
        if (!url) return null
        raw = (await downloadBuffer(url)).toString('utf8')
      }
      const text = String(raw).replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').trim().slice(0, MAX_BIOGRAPHY_CHARS)
      return text ? { text, createdOn: picked.createdOn } : null
    },

    async getPersonPhoto (personId) {
      const attachments = await get(`/person/${encodeURIComponent(personId)}/attachments`)
      const token = pickPhotoAttachment(attachments)
      if (!token) return null
      const urlResult = await get(`/attachment/url?token=${encodeURIComponent(token)}`)
      const url = typeof urlResult === 'string' ? urlResult : pick(urlResult, 'accessUrl', 'AccessUrl', 'url', 'Url')
      if (!url) return null
      return { buffer: await downloadBuffer(url), filename: `fiona-person-${personId}.jpg` }
    }
  }
}
