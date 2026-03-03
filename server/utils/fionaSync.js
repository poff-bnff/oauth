/**
 * fionaSync.js
 *
 * Fiona → Strapi bulk user / person sync.
 *
 * All Fiona API calls happen here in the OAuth app.
 * Data is written to Strapi via its admin REST API using the helpers in strapi.js.
 *
 * Entry point: runFionaSync()
 */

import { URLSearchParams } from 'url'
import { authenticateStrapiUser, getStrapiToken, getStrapiAdminToken } from './strapi.js'

// --------------------------------------------------------------------------
// Shared config / helpers
// --------------------------------------------------------------------------

const config = useRuntimeConfig()

const FIONA_BASE_URL = 'https://poff-xapi.fiona-app.com/api'
// The provider name used when looking up external authentications in Fiona.
// This is the name Fiona uses for the MyPoff OAuth provider.
const FIONA_PROVIDER_NAME = 'MyPoff'

const delay = ms => new Promise(resolve => setTimeout(resolve, ms))

/**
 * Generic Fiona GET with 3-attempt exponential-backoff retry.
 */
async function fionaFetch (path) {
  const url = `${FIONA_BASE_URL}${path}`
  const options = {
    method: 'GET',
    headers: { 'X-ApiKey': config.fionaApiKey }
  }

  const MAX_RETRIES = 3
  for (let i = 0; i < MAX_RETRIES; i++) {
    try {
      return await $fetch(url, options)
    } catch (err) {
      const isRetryable =
        err.code === 'EAI_AGAIN' || err.code === 'ENOTFOUND' || err.name === 'FetchError'
      if (i === MAX_RETRIES - 1 || !isRetryable) {
        console.error(`[fionaSync] fionaFetch failed after ${i + 1} attempts: ${url}`, err.message)
        throw err
      }
      console.warn(`[fionaSync] Retry ${i + 1} for ${url} (${err.code || err.name})`)
      await delay(500 * (i + 1))
    }
  }
}

/**
 * Generic Strapi GET using the admin token.
 */
async function strapiAdminFetch (path) {
  const token = await getStrapiAdminToken()
  return await $fetch(`${config.strapiUrl}${path}`, {
    headers: { Authorization: `Bearer ${token}` }
  })
}

/**
 * Generic Strapi PUT using the admin token.
 */
async function strapiAdminPut (path, body) {
  const token = await getStrapiAdminToken()
  return await $fetch(`${config.strapiUrl}${path}`, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body
  })
}

/**
 * Generic Strapi POST using the admin token.
 */
async function strapiAdminPost (path, body) {
  const token = await getStrapiAdminToken()
  return await $fetch(`${config.strapiUrl}${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body
  })
}

// --------------------------------------------------------------------------
// Part 3 — Fiona API helper functions
// --------------------------------------------------------------------------

/**
 * GET /guestbook/{guestbookId}/accreditations
 * Returns a lightweight list of all accreditations in the guestbook.
 */
export async function fetchAllAccreditations (guestbookId) {
  return await fionaFetch(`/guestbook/${guestbookId}/accreditations`)
}

/**
 * GET /accreditation/{accreditationId}/badges
 * Returns all badges for one accreditation.
 * Each item: { GuestbookBadge: { Description, Id }, Status: { Description, Id }, Id, Code, VoucherCode, ... }
 */
export async function fetchAccreditationBadges (accreditationId) {
  return await fionaFetch(`/accreditation/${accreditationId}/badges`)
}

/**
 * GET /accreditation/{accreditationId}
 * Full accreditation detail. Includes a nested `person` object with at least `id`.
 */
export async function fetchAccreditationDetail (accreditationId) {
  return await fionaFetch(`/accreditation/${accreditationId}`)
}

/**
 * GET /person/{personId}
 * Returns basic person data: { id, FirstName, LastName, Address, Nationality, Profession, ... }
 */
export async function fetchFionaPerson (personId) {
  return await fionaFetch(`/person/${personId}`)
}

/**
 * GET /person/{personId}/communicationItems
 * Returns all communication items; filter by type for email / phone.
 */
export async function fetchPersonCommunications (personId) {
  return await fionaFetch(`/person/${personId}/communicationItems`)
}

/**
 * GET /person/{personId}/{providerName}/externalauthentications
 * Returns the external auth records; `externalIdentification` is the login email.
 */
export async function fetchPersonExternalAuthentications (personId, providerName = FIONA_PROVIDER_NAME) {
  console.log(`[fionaSync] Fetching external authentications for person ${personId} and provider ${providerName}`)
  return await fionaFetch(`/person/${personId}/${providerName}/externalauthentications`)
}

/**
 * GET /person/{personId}/attachments
 * Returns all attachments for the person. Filter for images in category 2 (publication media).
 */
export async function fetchPersonAttachments (personId) {
  return await fionaFetch(`/person/${personId}/attachments`)
}

/**
 * GET /attachment/url?token={token}
 * Returns a short-lived (~15 min) S3 URL for the given attachment token.
 * Download the image immediately after calling this.
 */
export async function fetchAttachmentUrl (token) {
  return await fionaFetch(`/attachment/url?token=${encodeURIComponent(token)}`)
}

// --------------------------------------------------------------------------
// Part 4 — Strapi whitelist helpers
// --------------------------------------------------------------------------

/**
 * Load all active badge names from the Strapi whitelist.
 * @returns {Promise<Set<string>>}
 */
export async function loadBadgeWhitelist () {
  const items = await strapiAdminFetch('/fiona-badge-whitelists?active=true&_limit=-1')
  return new Set((items || []).map(i => i.badgeName).filter(Boolean))
}

/**
 * Load all active badge status names from the Strapi whitelist.
 * @returns {Promise<Set<string>>}
 */
export async function loadBadgeStatusWhitelist () {
  const items = await strapiAdminFetch('/fiona-badge-status-whitelists?active=true&_limit=-1')
  return new Set((items || []).map(i => i.statusName).filter(Boolean))
}

/**
 * Check whether at least one badge in the list matches the whitelists.
 *
 * @param {Array} badges             – raw Fiona badges array from fetchAccreditationBadges
 * @param {Set<string>} badgeWL      – whitelisted badge names
 * @param {Set<string>} statusWL     – whitelisted status names
 * @returns {{ matched: boolean, badge: object|null }}
 */
export function matchesWhitelist (badges, badgeWL, statusWL) {
  if (!Array.isArray(badges)) return { matched: false, badge: null }

  for (const badge of badges) {
    const badgeName = badge?.GuestbookBadge?.Description
    const statusName = badge?.Status?.Description
    if (badgeName && statusName && badgeWL.has(badgeName) && statusWL.has(statusName)) {
      return { matched: true, badge }
    }
  }
  return { matched: false, badge: null }
}

// --------------------------------------------------------------------------
// Part 5 — Strapi upsert helpers
// --------------------------------------------------------------------------

/**
 * Find the active festival-edition record in Strapi whose guestbook_id matches.
 * Returns an array of Strapi festival-edition IDs.
 */
async function resolveFestivalEditionIds (guestbookId) {
  try {
    const editions = await strapiAdminFetch(
      `/festival-editions?guestbook_id=${encodeURIComponent(guestbookId)}&_limit=-1`
    )
    return (editions || []).map(e => e.id)
  } catch {
    return []
  }
}

/**
 * Upload a photo buffer to Strapi's media library.
 * @param {Buffer} photoBuffer
 * @param {string} filename
 * @returns {number|null} Strapi file ID, or null on failure
 */
async function uploadPhotoToStrapi (photoBuffer, filename) {
  try {
    const token = await getStrapiAdminToken()
    const formData = new FormData()
    formData.append('files', new Blob([photoBuffer]), filename)

    const uploaded = await $fetch(`${config.strapiUrl}/upload`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: formData
    })

    return Array.isArray(uploaded) && uploaded[0] ? uploaded[0].id : null
  } catch (err) {
    console.error('[fionaSync] Failed to upload photo to Strapi:', err.message)
    return null
  }
}

/**
 * Download an image from a URL and return it as a Buffer.
 */
async function downloadImageBuffer (imageUrl) {
  try {
    const response = await fetch(imageUrl)
    if (!response.ok) return null
    const arrayBuffer = await response.arrayBuffer()
    return Buffer.from(arrayBuffer)
  } catch (err) {
    console.error('[fionaSync] Failed to download image:', err.message)
    return null
  }
}

/**
 * Create or update a Strapi `person` record from Fiona data.
 * Deduplication is by email (person.eMail).
 *
 * @param {string} loginEmail
 * @param {object} personPayload  – fields to write to the person record
 * @param {Buffer|null} photoBuffer
 * @returns {object} The Strapi person record (created or updated)
 */
export async function upsertStrapiPersonFromFiona (loginEmail, personPayload, photoBuffer) {
  // 1. Look up existing person by email
  let existingPeople = []
  try {
    existingPeople = await strapiAdminFetch(
      `/people?eMail=${encodeURIComponent(loginEmail)}&_limit=1`
    )
  } catch { /* no match */ }

  const existingPerson = Array.isArray(existingPeople) ? existingPeople[0] : null
  console.log(`[fionaSync] Existing Strapi person for email ${loginEmail}:`, existingPerson ? `ID ${existingPerson.id}` : 'none')
  // 2. Upload photo if provided
  let pictureId = existingPerson?.picture?.id || null
  if (photoBuffer) {
    const filename = `fiona-person-${personPayload.fiona_person_id || 'unknown'}.jpg`
    const uploadedId = await uploadPhotoToStrapi(photoBuffer, filename)
    if (uploadedId) pictureId = uploadedId
  }

  // 3. Merge festival_editions: union of existing IDs and incoming IDs
  const existingEditionIds = Array.isArray(existingPerson?.festival_editions)
    ? existingPerson.festival_editions.map(e => e?.id ?? e).filter(Boolean)
    : []
  const incomingEditionIds = Array.isArray(personPayload.festival_editions)
    ? personPayload.festival_editions
    : []
  const mergedEditionIds = [...new Set([...existingEditionIds, ...incomingEditionIds])]

  const payload = {
    ...personPayload,
    festival_editions: mergedEditionIds,
    fiona_synced_at: new Date().toISOString(),
    ...(pictureId ? { picture: pictureId } : {})
  }

  if (existingPerson) {
    // 3a. Update existing person (Fiona is authoritative — full overwrite)
    const record = await strapiAdminPut(`/people/${existingPerson.id}`, payload)
    return { record, wasNew: false }
  } else {
    // 3b. Create new person
    const record = await strapiAdminPost('/people', payload)
    return { record, wasNew: true }
  }
}

/**
 * Link a Strapi person record to a Strapi user.
 */
export async function linkPersonToUser (personId, userId) {
  if (!personId || !userId) return
  const token = await getStrapiAdminToken()
  await $fetch(`${config.strapiUrl}/users/${userId}`, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: { person: personId }
  })
}

/**
 * Create a user-profile for a Strapi user if one doesn't exist yet.
 */
async function ensureStrapiUserProfile (strapiUser) {
  if (strapiUser.user_profile) return

  const token = await getStrapiAdminToken()
  await $fetch(`${config.strapiUrl}/user-profiles`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: { user: strapiUser.id, email: strapiUser.email }
  })
}

// --------------------------------------------------------------------------
// Part 6 — Active guestbook loader (mirrors login-time logic in strapi.js)
// --------------------------------------------------------------------------

async function loadActiveGuestbookIds () {
  const token = await getStrapiToken()
  const today = new Date().toISOString().slice(0, 10)
  const params = new URLSearchParams()
  params.append('validUntil_gt', today)
  params.append('validFrom_lte', today)

  const festivals = await $fetch(
    `${config.strapiUrl}/festival-editions?${params.toString()}`,
    { headers: { Authorization: `Bearer ${token}` } }
  )

  return [
    ...new Set(
      (festivals || [])
        .map(f => f?.guestbook_id)
        .filter(id => id != null)
    )
  ]
}

// --------------------------------------------------------------------------
// Part 6 — Core sync orchestrator
// --------------------------------------------------------------------------

let syncRunning = false

/**
 * Main entry point. Runs the full Fiona → Strapi bulk sync.
 *
 * @param {{ dryRun?: boolean }} options
 * @returns {Promise<{ processed: number, created: number, updated: number, skipped: number, errors: number }>}
 */
export async function runFionaSync ({ dryRun = false } = {}) {
  if (syncRunning) {
    console.warn('[fionaSync] Sync already running — skipping this invocation')
    return { processed: 0, created: 0, updated: 0, skipped: 1, errors: 0 }
  }
  syncRunning = true
  const startedAt = Date.now()
  const stats = { processed: 0, created: 0, updated: 0, skipped: 0, errors: 0 }

  console.log(`[fionaSync] ▶ Starting Fiona sync${dryRun ? ' (DRY RUN)' : ''} at ${new Date().toISOString()}`)

  try {
    // 1. Load whitelists
    const [badgeWL, statusWL] = await Promise.all([
      loadBadgeWhitelist(),
      loadBadgeStatusWhitelist()
    ])

    if (badgeWL.size === 0 || statusWL.size === 0) {
      console.warn('[fionaSync] Whitelist(s) empty — nothing to sync. Add entries via Strapi admin.')
      return stats
    }

    console.log(`[fionaSync] Badge whitelist: [${[...badgeWL].join(', ')}]`)
    console.log(`[fionaSync] Status whitelist: [${[...statusWL].join(', ')}]`)

    // 2. Load active guestbook IDs from Strapi festival-editions
    const guestbookIds = await loadActiveGuestbookIds()
    console.log(`[fionaSync] Active guestbooks: ${guestbookIds.length} → [${guestbookIds.join(', ')}]`)

    // 3. Process each guestbook
    for (const guestbookId of guestbookIds) {
      let accreditations = []
      try {
        accreditations = await fetchAllAccreditations(guestbookId)
      } catch (err) {
        console.error(`[fionaSync] Failed to fetch accreditations for guestbook ${guestbookId}:`, err.message)
        stats.errors++
        continue
      }

      console.log(`[fionaSync] Guestbook ${guestbookId}: ${accreditations.length} accreditations`)

      // 4. Pre-resolve festival-edition IDs for this guestbook
      const festivalEditionIds = await resolveFestivalEditionIds(guestbookId)

      for (const accreditation of accreditations) {
        stats.processed++
        const accreditationId = accreditation.Id || accreditation.id

        try {
          // 4a. Check badges against whitelist
          let badges = []
          try {
            badges = await fetchAccreditationBadges(accreditationId)
          } catch (err) {
            console.warn(`[fionaSync] Cannot fetch badges for accreditation ${accreditationId}:`, err.message)
            stats.skipped++
            continue
          }

          const { matched } = matchesWhitelist(badges, badgeWL, statusWL)
          if (!matched) {
            stats.skipped++
            continue
          }

          // 4b. Get full accreditation detail → person ID
          const detail = await fetchAccreditationDetail(accreditationId)
          const personId = detail?.person?.id || detail?.Person?.Id
          if (!personId) {
            console.warn(`[fionaSync] Accreditation ${accreditationId} has no linked person — skipping`)
            stats.skipped++
            continue
          }

          // 4c. Fetch person data from Fiona
          const [fionaPerson, comms] = await Promise.all([
            fetchFionaPerson(personId),
            fetchPersonCommunications(personId)
          ])

          // 4d. Resolve Strapi user via Fiona external authentication
          //     ExternalIdentification = Strapi user ID (numeric string, e.g. "22135")
          let existingStrapiUser = null
          let loginEmail = null

          try {
            const externalAuths = await fetchPersonExternalAuthentications(personId)
            const extId = Array.isArray(externalAuths) && externalAuths[0]?.ExternalIdentification
            if (extId) {
              existingStrapiUser = await strapiAdminFetch(`/users/${extId}`)
              loginEmail = existingStrapiUser?.email || null
              console.log(`[fionaSync] Resolved Strapi user ${existingStrapiUser?.id} via Fiona external auth for person ${personId}`)
            }
          } catch { /* no external auth record */ }

          // Fallback: ContactDetails on person object (PascalCase), then communicationItems
          if (!loginEmail && Array.isArray(fionaPerson.ContactDetails)) {
            const emailContact = fionaPerson.ContactDetails.find(
              c => c?.Type?.Description?.toLowerCase() === 'email'
            )
            loginEmail = emailContact?.Value || null
          }
          if (!loginEmail && Array.isArray(comms)) {
            const emailComm = comms.find(c => c?.type?.description?.toLowerCase() === 'email')
            loginEmail = emailComm?.value || null
          }

          if (!loginEmail) {
            console.warn(`[fionaSync] No login email for Fiona person ${personId} (accreditation ${accreditationId}) — skipping`)
            stats.skipped++
            continue
          }

          console.log(`[fionaSync] Processing accreditation ${accreditationId} for person ${personId} (${fionaPerson.FirstName} ${fionaPerson.LastName}), login email: ${loginEmail}`)

          // 4e. Resolve phone — ContactDetails first, then communicationItems
          let phoneNr = null

          if (Array.isArray(fionaPerson.ContactDetails)) {
            const phoneContact = fionaPerson.ContactDetails.find(
              c => c?.Type?.Description?.toLowerCase() === 'phone'
            )
            phoneNr = phoneContact?.Value || null
          }
          if (!phoneNr && Array.isArray(comms)) {
            const phoneComm = comms.find(c => c?.type?.description?.toLowerCase() === 'phone')
            phoneNr = phoneComm?.value || null
          }

          // 4f. Fetch person photo
          let photoBuffer = null
          try {
            const attachments = await fetchPersonAttachments(personId)
            // Prefer category 2 (publication media) images, fall back to category 0
            const photoAttachment = Array.isArray(attachments)
              ? (attachments.find(a => a.category === 2 && a.contentType?.description?.toLowerCase().includes('image')) ||
                 attachments.find(a => a.category === 0 && a.contentType?.description?.toLowerCase().includes('image')))
              : null

            if (photoAttachment?.value) {
              const urlResult = await fetchAttachmentUrl(photoAttachment.value)
              const downloadUrl = urlResult?.url || urlResult
              if (downloadUrl) {
                photoBuffer = await downloadImageBuffer(downloadUrl)
              }
            }
          } catch (err) {
            console.warn(`[fionaSync] Photo fetch failed for person ${personId}:`, err.message)
          }

          // 4g. Build person payload
          const personPayload = {
            firstName: fionaPerson.FirstName || null,
            lastName: fionaPerson.LastName || null,
            firstNameLastName: [fionaPerson.FirstName, fionaPerson.LastName].filter(Boolean).join(' ') || null,
            eMail: loginEmail,
            phoneNr,
            // ev_country is a Strapi relation (integer FK) — Fiona provides a UUID, no direct mapping available
            bio_en: detail.biography || detail.Biography || fionaPerson.biography || fionaPerson.Biography || null,
            fiona_person_id: personId,
            fiona_accreditation_id: accreditationId,
            festival_editions: festivalEditionIds
          }

          if (dryRun) {
            console.log(`[fionaSync] DRY RUN — would upsert person: ${loginEmail} (${fionaPerson.FirstName} ${fionaPerson.LastName})`)
            stats.updated++
            continue
          }

          // 4h. Upsert Strapi person (Fiona is authoritative — always overwrite)
          const { record: person, wasNew } = await upsertStrapiPersonFromFiona(loginEmail, personPayload, photoBuffer)

          // 4i. Ensure Strapi user exists and link to person
          //     Prefer the user we already resolved via external auth to avoid an extra API call
          let strapiUser = existingStrapiUser
          if (!strapiUser) {
            strapiUser = await authenticateStrapiUser(loginEmail)
          }
          if (strapiUser && person?.id) {
            await linkPersonToUser(person.id, strapiUser.id)
            // Only create user-profile if it doesn't already exist
            if (!strapiUser.user_profile) {
              await ensureStrapiUserProfile(strapiUser)
            }
          }

          wasNew ? stats.created++ : stats.updated++

          // Small delay to avoid hammering Fiona API
          await delay(100)
        } catch (err) {
          console.error(`[fionaSync] Error processing accreditation ${accreditationId}:`, err.message)
          stats.errors++
        }
      }
    }
  } catch (err) {
    console.error('[fionaSync] Fatal error during sync:', err)
    stats.errors++
  } finally {
    syncRunning = false
  }

  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1)
  console.log(
    `[fionaSync] ✅ Done in ${elapsed}s — ` +
    `processed: ${stats.processed}, created: ${stats.created}, updated: ${stats.updated}, ` +
    `skipped: ${stats.skipped}, errors: ${stats.errors}`
  )

  return stats
}
