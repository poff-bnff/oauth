/**
 * fiona/roleRepair.js
 *
 * Mode `roleRepair` of POST /api/sync/fiona: gives a Strapi user-role (e.g. 15 "Industry 2026 participant") to the logins of the persons who
 * hold a badge the role's own rule accepts but do not have the role. roleAudit finds them; this does what hunt's login-time badge check would
 * do, without waiting for a login and without the Fiona MyPoff link (which some persons have lost).
 *
 * It only ADDS the role: every role the user has stays. A dry run unless `dryRun` is explicitly false. It repairs
 *   linked-role-missing     the link is a login (its main login, for an alias) that lacks the role
 *   unlinked-role-missing   no Fiona link, exactly one login with the person's e-mail (its main login, for an alias) lacks the role
 * and leaves the rest to people (`notRepairable`: no login, several logins, a link to a missing user, a failed read). A blocked user is never
 * touched. A user is written once however many persons lead to it, and each write is checked by reading the user back. The login-time check
 * keeps a badge role when Fiona cannot be read (oauth PR #250), so a repaired user without a Fiona link does not lose the role at the next login.
 *
 * Ids and counts only: no names, e-mails or contact details. No Nuxt auto-imports here so the module is unit-testable.
 */

import { roleAudit } from './roleAudit.js'

export const REPAIRABLE = ['linked-role-missing', 'unlinked-role-missing']

const shortMessage = err => String(err?.message || err).slice(0, 200)
const relationId = value => (value && typeof value === 'object' ? value.id : value)
const roleIdsOf = user => (Array.isArray(user?.user_roles) ? user.user_roles : []).map(item => Number(relationId(item))).filter(Number.isFinite)

/**
 * @param {{ roleId: number, guestbookId?: string, offset?: number, limit?: number, dryRun?: boolean, categories?: string[], loadRole: Function, strapi: object, xapi: object, log?: object }} options
 *   strapi needs what roleAudit needs plus setUserRoles(userId, roleIds)
 */
export async function roleRepair ({ roleId, guestbookId = '', offset = 0, limit, dryRun = true, categories = REPAIRABLE, loadRole, strapi, xapi, log = console } = {}) {
  const wanted = new Set((Array.isArray(categories) && categories.length ? categories : REPAIRABLE).filter(category => REPAIRABLE.includes(category)))
  if (!wanted.size) throw new Error(`roleRepair repairs only ${REPAIRABLE.join(' and ')}`)
  const asDryRun = dryRun !== false

  const audit = await roleAudit({ roleId, guestbookId, offset, limit, loadRole, strapi, xapi, log })

  const notRepairable = {}
  const targets = new Map() // userId → the categories that led to it
  for (const person of audit.persons) {
    if (wanted.has(person.category) && person.userId) {
      const categoriesOfUser = targets.get(Number(person.userId)) || new Set()
      categoriesOfUser.add(person.category)
      targets.set(Number(person.userId), categoriesOfUser)
    } else if (!REPAIRABLE.includes(person.category)) {
      notRepairable[person.category] = (notRepairable[person.category] || 0) + 1
    }
  }

  const result = { planned: 0, granted: 0, alreadyHad: 0 }
  const skipped = {}
  const errors = []
  const users = []

  for (const userId of [...targets.keys()].sort((a, b) => a - b)) {
    const via = [...targets.get(userId)].sort()
    try {
      const user = await strapi.getUser(userId) // read afresh: what the user has now is what must stay
      if (!user) { skipped.userNotFound = (skipped.userNotFound || 0) + 1; continue }
      if (relationId(user.mainUser)) { skipped.alias = (skipped.alias || 0) + 1; continue }
      if (user.blocked === true) { skipped.blocked = (skipped.blocked || 0) + 1; continue }
      const have = roleIdsOf(user)
      if (have.includes(Number(audit.roleId))) { result.alreadyHad++; continue }

      if (asDryRun) {
        result.planned++
        users.push({ userId, action: 'would-grant', categories: via })
        continue
      }
      const next = [...have, Number(audit.roleId)]
      await strapi.setUserRoles(userId, next)
      const after = roleIdsOf(await strapi.getUser(userId))
      if (!next.every(id => after.includes(id))) throw new Error(`the roles could not be read back as written (${after.length} roles after the write, expected ${next.length})`)
      result.granted++
      users.push({ userId, action: 'granted', categories: via })
    } catch (err) {
      log.warn?.(`[fiona roleRepair] user ${userId}: ${shortMessage(err)}`)
      errors.push({ userId, error: shortMessage(err) })
    }
  }

  return {
    roleId: audit.roleId,
    guestbookId: audit.guestbookId,
    total: audit.total,
    offset: audit.offset,
    limit: audit.limit,
    nextOffset: audit.nextOffset,
    audited: audit.audited,
    qualifying: audit.qualifying,
    dryRun: asDryRun,
    categories: [...wanted],
    ...result,
    notRepairable,
    skipped,
    errors,
    users
  }
}
