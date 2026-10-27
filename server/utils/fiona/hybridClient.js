/**
 * fiona/hybridClient.js
 *
 * "Publication API first, XAPI only when needed."
 *
 * Every list and lookup goes to the Publication client. The XAPI is touched
 * only for a person the sync is about to write, and only for what the
 * published record lacks:
 *   - no published email  → XAPI person (communication items) for the login email
 *   - no MyPoff link      → XAPI external authentications (prevents a second
 *                           login account for someone who already has one)
 * A biography comes from the accreditation card ONLY: the Memo whose content type is Biography, published or not. The
 * biography published on the person itself is ignored on purpose (decision with Jaan). Needs allowUnpublishedBios, a
 * full-profile person and the XAPI; otherwise the person gets no biography from the sync.
 * Photos are editorial content: the published one comes first. Only when the switch allowUnpublishedPhotos is on, a
 * full-profile person without a published photo gets the attachment whose content type is Headshot, published or not.
 * XAPI failures never fail the sync: the published data is kept and a
 * warning is logged.
 */

async function fallback (log, label, personId, fn, fallbackValue) {
  try {
    return await fn()
  } catch (err) {
    log.warn?.(`[fiona] XAPI fallback ${label} for person ${personId} failed: ${err?.message || err}`)
    return fallbackValue
  }
}

export function createHybridClient ({ publication, xapi = null, log = console, allowUnpublishedPhotos = false, allowUnpublishedBios = false }) {
  if (!publication) throw new Error('createHybridClient: publication client is required')

  return {
    resetCache: () => publication.resetCache?.(),
    listGuestbooks: (...args) => publication.listGuestbooks(...args),
    listGuestbookBadges: (...args) => publication.listGuestbookBadges(...args),
    listAccreditations: (...args) => publication.listAccreditations(...args),
    getAccreditationBadges: (...args) => publication.getAccreditationBadges(...args),
    getAccreditation: (...args) => publication.getAccreditation(...args),
    listMutations: (...args) => publication.listMutations(...args),
    getAccreditationBadgeRecord: (...args) => publication.getAccreditationBadgeRecord(...args),
    getPersonAccreditations: (...args) => publication.getPersonAccreditations(...args),

    async getPerson (personId, { accreditationIds = [], level = 1 } = {}) {
      let result = await publication.getPerson(personId)
      if (!result.email && xapi) {
        const extra = await fallback(log, 'person', personId, () => xapi.getPerson(personId), null)
        if (extra) {
          result = {
            ...result,
            email: extra.email || null,
            phone: result.phone || extra.phone || null,
            emailSource: extra.email ? 'xapi' : undefined
          }
        }
      }
      result = { ...result, bio: null }
      if (!allowUnpublishedBios || level < 2 || typeof xapi?.getUnpublishedBiography !== 'function') return result
      const card = await fallback(log, 'biography', personId, () => xapi.getUnpublishedBiography(accreditationIds), null)
      return card?.text ? { ...result, bio: card.text, bioSource: 'accreditation' } : result
    },

    async getMyPoffUserId (personId) {
      const published = await publication.getMyPoffUserId(personId)
      if (published || !xapi) return published || null
      return await fallback(log, 'MyPoff link', personId, () => xapi.getMyPoffUserId(personId), null)
    },

    async getPersonPhoto (personId, { accreditationIds = [], level = 1 } = {}) {
      const published = await publication.getPersonPhoto(personId)
      if (published) return { ...published, source: 'published' }
      if (!allowUnpublishedPhotos || level < 2 || typeof xapi?.getUnpublishedHeadshot !== 'function') return null
      const headshot = await fallback(log, 'Headshot', personId, () => xapi.getUnpublishedHeadshot(personId, accreditationIds), null)
      return headshot ? { ...headshot, source: 'headshot' } : null
    }
  }
}
