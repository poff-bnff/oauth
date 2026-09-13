/**
 * fiona/hybridClient.js
 *
 * "Publication API first, XAPI only when needed."
 *
 * Every list and lookup goes to the Publication client. The XAPI is touched
 * only for a person the sync is about to write, and only for what the
 * published record lacks:
 *   - no published email  → XAPI person (communication items) for the login email
 *   - no MyPoff link      → XAPI external authentications
 *   - no published photo  → XAPI attachments
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

export function createHybridClient ({ publication, xapi = null, log = console }) {
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

    async getPerson (personId) {
      const person = await publication.getPerson(personId)
      if (person.email || !xapi) return person
      const extra = await fallback(log, 'person', personId, () => xapi.getPerson(personId), null)
      if (!extra) return person
      return {
        ...person,
        email: extra.email || null,
        phone: person.phone || extra.phone || null,
        emailSource: extra.email ? 'xapi' : undefined
      }
    },

    async getMyPoffUserId (personId) {
      const published = await publication.getMyPoffUserId(personId)
      if (published || !xapi) return published || null
      return await fallback(log, 'MyPoff link', personId, () => xapi.getMyPoffUserId(personId), null)
    },

    async getPersonPhoto (personId) {
      const published = await publication.getPersonPhoto(personId)
      if (published || !xapi) return published || null
      return await fallback(log, 'photo', personId, () => xapi.getPersonPhoto(personId), null)
    }
  }
}
