/**
 * fiona/compare.js
 *
 * Diagnostic: read the same guestbooks through the XAPI and the Publication
 * API and report, per accreditation with badges, who is missing on which
 * side and where the badge status texts differ. Answers "is every badge
 * holder published, and do both APIs agree on the statuses?" before the
 * sync source is switched. Read-only.
 */

const norm = value => String(value ?? '').trim().toLowerCase()
const badgeLine = badge => `${badge.badgeName || badge.badgeId}: ${badge.statusText || '(no status)'}`

async function badgeHolders (client, guestbookId) {
  const holders = new Map() // accreditationId → badges
  const accreditations = await client.listAccreditations(guestbookId)
  for (const accreditation of accreditations) {
    const badges = await client.getAccreditationBadges(accreditation.id)
    if (badges.length) holders.set(String(accreditation.id), badges)
  }
  return { total: accreditations.length, holders }
}

export async function compareSources ({ xapi, publication, guestbookIds, log = console }) {
  const result = { guestbooks: {} }
  for (const guestbookId of guestbookIds) {
    try {
      const [x, p] = await Promise.all([badgeHolders(xapi, guestbookId), badgeHolders(publication, guestbookId)])
      const onlyInXapi = []
      const onlyInPublication = []
      const statusDiffs = []
      let identical = 0

      for (const [id, badges] of x.holders) {
        if (!p.holders.has(id)) { onlyInXapi.push({ id, badges: badges.map(badgeLine) }); continue }
        const published = p.holders.get(id)
        let same = true
        for (const badge of badges) {
          const match = published.find(b => norm(b.badgeId) === norm(badge.badgeId)) ||
            published.find(b => norm(b.badgeName) === norm(badge.badgeName))
          const publicationStatus = match ? norm(match.statusText) : '(badge missing)'
          if (publicationStatus !== norm(badge.statusText)) {
            same = false
            statusDiffs.push({ id, badge: badge.badgeName || badge.badgeId, xapi: norm(badge.statusText), publication: publicationStatus })
          }
        }
        if (same) identical++
      }
      for (const [id, badges] of p.holders) {
        if (!x.holders.has(id)) onlyInPublication.push({ id, badges: badges.map(badgeLine) })
      }

      result.guestbooks[guestbookId] = {
        xapiAccreditations: x.total,
        publicationAccreditations: p.total,
        xapiBadgeHolders: x.holders.size,
        publicationBadgeHolders: p.holders.size,
        identicalBadgeHolders: identical,
        onlyInXapi,
        onlyInPublication,
        statusDiffs
      }
      log.info?.(`[fiona compare] guestbook ${guestbookId}: xapi ${x.total}/${x.holders.size} holders, publication ${p.total}/${p.holders.size} holders, identical ${identical}, onlyInXapi ${onlyInXapi.length}, onlyInPublication ${onlyInPublication.length}, statusDiffs ${statusDiffs.length}`)
    } catch (err) {
      result.guestbooks[guestbookId] = { error: err?.message || String(err) }
      log.error?.(`[fiona compare] guestbook ${guestbookId}: ${err?.message || err}`)
    }
  }
  return result
}
