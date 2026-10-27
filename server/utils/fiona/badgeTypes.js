/**
 * fiona/badgeTypes.js
 *
 * Read-only: the badge types of Fiona guestbooks with their ids, straight from the XAPI. The badge id is what a
 * fiona-sync-rule matches on (badge_type_id), so this is the list to copy it from.
 */

/**
 * @param {{ guestbookIds?: string[], xapi: object, strapi: object, log?: object }} options
 *   guestbookIds empty = the guestbooks of the active festival editions
 * @returns {Promise<{ guestbooks: Array<{ id: string, name: string|null, badges: Array<{ id: string, name: string }> }>, errors: Array<{ guestbookId: string, message: string }> }>}
 */
export async function listBadgeTypes ({ guestbookIds = [], xapi, strapi, log = console } = {}) {
  const wanted = (Array.isArray(guestbookIds) ? guestbookIds : []).map(String).filter(Boolean)
  const ids = wanted.length ? [...new Set(wanted)] : await strapi.getActiveGuestbookIds()
  const names = new Map((await xapi.listGuestbooks()).map(guestbook => [String(guestbook.id), guestbook.name]))

  const result = { guestbooks: [], errors: [] }
  for (const id of ids) {
    try {
      const badges = (await xapi.listGuestbookBadges(id)).map(badge => ({ id: badge.id, name: badge.name }))
      badges.sort((a, b) => String(a.name).localeCompare(String(b.name)))
      result.guestbooks.push({ id, name: names.get(String(id)) ?? null, badges })
    } catch (err) {
      result.errors.push({ guestbookId: id, message: err?.message || String(err) })
      log.warn?.(`[fiona badges] guestbook ${id}: ${err?.message || err}`)
    }
  }
  return result
}
