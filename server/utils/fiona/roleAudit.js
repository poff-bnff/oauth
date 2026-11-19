/**
 * fiona/roleAudit.js
 *
 * Read-only probe (mode `roleAudit` of POST /api/sync/fiona): who in the active guestbook holds a badge that earns a Strapi user-role
 * (the role's own badge rule, e.g. role 15 "Industry 2026 participant": badge names with the statuses that count), and does that person
 * still have the role and the Fiona MyPoff login link?
 *
 * The role is given and taken away only by hunt's login-time badge check (strapi.js updateUserAndAliasesRoles), which reads the badges
 * through the MyPoff link. So "has the badge, lacks the role" means the person has not logged in since, or lost it; read together with
 * the link (a 404 from Fiona = no link) it shows which. It reads a page of accreditations at a time, so one call stays small. Ids and
 * categories only: no names, e-mails or contact details.
 *
 * Categories (one per person; `role-ok` is counted, not listed):
 *   role-ok                  linked, and the login (the main login when the link is an alias) has the role
 *   linked-role-missing      linked, the login lacks the role
 *   linked-to-missing-user   the link is a Strapi user that does not exist
 *   unlinked-role-ok         no link in Fiona, the Strapi user found by e-mail has the role
 *   unlinked-role-missing    no link in Fiona, the Strapi user found by e-mail lacks the role
 *   unlinked-no-user         no link, no Strapi user with the e-mail
 *   unlinked-several-users   no link, several Strapi users with the e-mail (`userIds`)
 *   unlinked-no-email        no link, and Fiona holds no e-mail for the person
 *   fiona-error / strapi-error   a read failed: nothing is concluded (a failed read is never "unlinked")
 *
 * No Nuxt auto-imports here so the module is unit-testable.
 */

import { readMyPoffLinks } from './linkAudit.js'

const MAX_LIMIT = 40
const DEFAULT_LIMIT = 20

const norm = value => String(value ?? '').trim().toLowerCase()
const relationId = value => (value && typeof value === 'object' ? value.id : value)
const shortMessage = err => String(err?.message || err).slice(0, 200)

/** The role's badge rule as a Map: badge name (lower case) → Set of statuses (lower case) that earn the role. */
function badgeRuleOf (role) {
  const rule = new Map()
  for (const entry of Array.isArray(role?.user_badges) ? role.user_badges : []) {
    const name = norm(entry?.badgeName)
    if (!name) continue
    const statuses = rule.get(name) || new Set()
    for (const status of String(entry?.badgeStatuses ?? '').split(',').map(norm).filter(Boolean)) statuses.add(status)
    rule.set(name, statuses)
  }
  return rule
}

/**
 * @param {{ roleId: number, guestbookId?: string, offset?: number, limit?: number, loadRole: Function, strapi: object, xapi: object, log?: object }} options
 *   loadRole(roleId) → { id, user_badges: [{ badgeName, badgeStatuses }] } | null
 *   strapi needs getActiveGuestbookIds, getUser and findUsersByEmail; xapi needs listAccreditations, getAccreditationBadges, getAccreditation, getPerson, getRaw
 */
export async function roleAudit ({ roleId, guestbookId = '', offset = 0, limit = DEFAULT_LIMIT, loadRole, strapi, xapi, log = console } = {}) {
  const pageSize = Number.isInteger(Number(limit)) && Number(limit) > 0 ? Number(limit) : DEFAULT_LIMIT
  if (pageSize > MAX_LIMIT) throw new Error(`roleAudit reads at most ${MAX_LIMIT} accreditations per call`)
  const start = Number.isInteger(Number(offset)) && Number(offset) > 0 ? Number(offset) : 0

  const role = await loadRole(roleId)
  if (!role) throw new Error(`role ${roleId} was not found`)
  const rule = badgeRuleOf(role)
  if (!rule.size) throw new Error(`role ${roleId} has no badge rule`)

  const guestbook = String(guestbookId || '').trim() || (await strapi.getActiveGuestbookIds())[0]
  if (!guestbook) throw new Error('roleAudit needs a guestbook: none is active and none was given')

  const accreditations = (await xapi.listAccreditations(guestbook)).map(item => String(item.id)).sort()
  const page = accreditations.slice(start, start + pageSize)
  const nextOffset = start + pageSize < accreditations.length ? start + pageSize : null

  const users = new Map() // a Strapi user is read once, however many persons share it
  const userOf = (id) => {
    const key = String(id)
    if (!users.has(key)) users.set(key, Promise.resolve(strapi.getUser(id)))
    return users.get(key)
  }
  const hasRole = user => (Array.isArray(user?.user_roles) ? user.user_roles : []).some(item => Number(relationId(item)) === Number(role.id))
  const strapiPersonOf = user => (relationId(user?.person) ? Number(relationId(user.person)) : null)

  const counts = {}
  const skipped = { noRoleBadge: 0, status: 0, noPerson: 0 }
  const listed = []
  const seenPersons = new Set()
  let qualifying = 0

  const add = (item) => {
    counts[item.category] = (counts[item.category] || 0) + 1
    if (item.category !== 'role-ok') listed.push(item)
  }

  for (const accreditationId of page) {
    let earned
    let fionaPersonId
    try {
      const badges = await xapi.getAccreditationBadges(accreditationId)
      const known = badges.filter(badge => rule.has(norm(badge.badgeName)))
      if (!known.length) { skipped.noRoleBadge++; continue }
      earned = known.filter(badge => rule.get(norm(badge.badgeName)).has(norm(badge.statusText)))
      if (!earned.length) { skipped.status++; continue }
      fionaPersonId = String((await xapi.getAccreditation(accreditationId)).personId || '')
      if (!fionaPersonId) { skipped.noPerson++; continue }
    } catch (err) {
      log.warn?.(`[fiona roleAudit] accreditation ${accreditationId}: ${shortMessage(err)}`)
      qualifying++
      add({ accreditationId, category: 'fiona-error', error: shortMessage(err) })
      continue
    }
    if (seenPersons.has(fionaPersonId)) continue
    seenPersons.add(fionaPersonId)
    qualifying++

    const base = { accreditationId, fionaPersonId, badges: earned.map(badge => `${badge.badgeName} (${badge.statusText})`) }
    try {
      add(await classify(base, fionaPersonId))
    } catch (err) {
      log.warn?.(`[fiona roleAudit] person ${fionaPersonId}: ${shortMessage(err)}`)
      add({ ...base, category: 'strapi-error', error: shortMessage(err) })
    }
  }

  async function classify (base, fionaPersonId) {
    const read = await readMyPoffLinks(xapi, fionaPersonId)
    if (read.error) return { ...base, category: 'fiona-error', error: read.error }

    if (read.linkIds.length) {
      const linkedUserId = Number(read.linkIds[0])
      const linked = await userOf(linkedUserId)
      if (!linked) return { ...base, category: 'linked-to-missing-user', linkedUserId }
      // badge roles go to the main login: when the link is an alias, the main login is the one to look at
      const mainId = relationId(linked.mainUser) ? Number(relationId(linked.mainUser)) : null
      const holder = mainId ? (await userOf(mainId)) || linked : linked
      return { ...base, category: hasRole(holder) ? 'role-ok' : 'linked-role-missing', linkedUserId, userId: Number(holder.id), ...(strapiPersonOf(holder) ? { strapiPersonId: strapiPersonOf(holder) } : {}) }
    }

    const email = (await xapi.getPerson(fionaPersonId))?.email
    if (!email) return { ...base, category: 'unlinked-no-email', fionaAnswer: read.answer }
    const found = await strapi.findUsersByEmail(email)
    if (!found.length) return { ...base, category: 'unlinked-no-user', fionaAnswer: read.answer }
    if (found.length > 1) return { ...base, category: 'unlinked-several-users', fionaAnswer: read.answer, userIds: found.map(item => Number(item.id)).sort((a, b) => a - b), anyHasRole: found.some(hasRole) }
    const [only] = found
    return { ...base, category: hasRole(only) ? 'unlinked-role-ok' : 'unlinked-role-missing', fionaAnswer: read.answer, userId: Number(only.id), ...(strapiPersonOf(only) ? { strapiPersonId: strapiPersonOf(only) } : {}) }
  }

  return { roleId: Number(role.id), guestbookId: guestbook, total: accreditations.length, offset: start, limit: pageSize, nextOffset, audited: page.length, qualifying, counts, skipped, persons: listed }
}
