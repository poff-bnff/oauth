/**
 * fiona/rolesReadReport.js
 *
 * Read-only probe (mode `roles` of POST /api/sync/fiona): can the user-roles be read WITHOUT their users?
 *
 * GET /user-roles?_limit=-1 loads every user of every role (about 17 MB) and kept Strapi at 100 % CPU on 2026-11-12.
 * Login only needs each role's id and badge rules (user_badges: badgeName + badgeStatuses). This times a read of just
 * those fields and, when a REST reader is given, compares it once with the REST read, so nothing is switched over
 * before the two are known to agree. The report holds ids, counts, timings and badge rules (configuration, never
 * personal data) and the function never throws.
 */

/** Badge statuses are a comma list ("Approved, Printed"): order and spacing do not matter. */
const normaliseStatuses = value => String(value ?? '').split(',').map(part => part.trim()).filter(Boolean).sort().join(',')

/** A role's badge rules as sorted strings, so two sources can be compared whatever the order and the extra fields. */
const rulesOf = role => (Array.isArray(role?.user_badges) ? role.user_badges : [])
  .map(badge => `${badge?.badgeName ?? ''}|${normaliseStatuses(badge?.badgeStatuses)}`)
  .sort()

/** Reads one source; the answer must be a non-empty list of roles that all have an id (an empty list would strip every role). */
async function readSource (read, now) {
  const startedAt = now()
  try {
    const roles = await read()
    if (!Array.isArray(roles) || roles.length === 0) throw new Error('no roles returned')
    if (roles.some(role => role?.id === undefined || role?.id === null)) throw new Error('a role without an id')
    return { roles, summary: { ok: true, ms: now() - startedAt, roles: roles.length, withBadgeRules: roles.filter(role => rulesOf(role).length > 0).length } }
  } catch (err) {
    return { roles: null, summary: { ok: false, ms: now() - startedAt, error: String(err?.message || err) } }
  }
}

function compareRoles (graphqlRoles, restRoles) {
  const byId = roles => new Map(roles.map(role => [Number(role.id), rulesOf(role)]))
  const fromGraphql = byId(graphqlRoles)
  const fromRest = byId(restRoles)
  const numeric = (a, b) => a - b

  const onlyInGraphql = [...fromGraphql.keys()].filter(id => !fromRest.has(id)).sort(numeric)
  const onlyInRest = [...fromRest.keys()].filter(id => !fromGraphql.has(id)).sort(numeric)
  const differentRules = [...fromGraphql.keys()]
    .filter(id => fromRest.has(id) && JSON.stringify(fromGraphql.get(id)) !== JSON.stringify(fromRest.get(id)))
    .sort(numeric)
    .map(id => ({ id, graphql: fromGraphql.get(id), rest: fromRest.get(id) }))

  return { equal: !onlyInGraphql.length && !onlyInRest.length && !differentRules.length, onlyInRest, onlyInGraphql, differentRules }
}

/**
 * @param {{ graphql: () => Promise<Array>, rest?: (() => Promise<Array>)|null, now?: () => number }} options
 *   graphql: reads id + user_badges only; rest: the full REST read (heavy: give it once, on purpose)
 */
export async function rolesReadReport ({ graphql, rest = null, now = Date.now }) {
  const fromGraphql = await readSource(graphql, now)
  const fromRest = rest ? await readSource(rest, now) : null
  const comparison = fromGraphql.roles && fromRest?.roles ? compareRoles(fromGraphql.roles, fromRest.roles) : null
  return { graphql: fromGraphql.summary, rest: fromRest ? fromRest.summary : null, comparison }
}
