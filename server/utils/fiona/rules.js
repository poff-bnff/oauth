/**
 * fiona/rules.js
 *
 * Pure helpers for the Strapi `fiona-sync-rule` collection: parsing rules,
 * indexing them by badge and evaluating the badges of one accreditation.
 *
 * A rule has two levels:
 *   level 1 (`sync_statuses`)          → basic person / user / profile sync
 *   level 2 (`full_profile_statuses`)  → full profile + festival editions + user roles
 * Level 2 is always a subset of level 1.
 *
 * No Nuxt auto-imports here so the module is unit-testable.
 */

const norm = value => String(value ?? '').trim().toLowerCase()

/**
 * "Approved, paid ,PRINTED,," → Set { 'approved', 'paid', 'printed' }
 */
export function parseStatusList (value) {
  return new Set(
    String(value ?? '')
      .split(',')
      .map(norm)
      .filter(Boolean)
  )
}

const relationIds = list => (Array.isArray(list) ? list : [])
  .map(item => (item && typeof item === 'object' ? item.id : item))
  .filter(id => id !== null && id !== undefined)

/**
 * Turn raw Strapi rule records into normalised rules.
 * Returns { rules, warnings }.
 */
export function normalizeRules (rawRules) {
  const rules = []
  const warnings = []

  for (const raw of Array.isArray(rawRules) ? rawRules : []) {
    if (!raw || raw.active === false) continue

    const badgeId = norm(raw.badge_type_id)
    const badgeName = norm(raw.badge_type_name)
    if (!badgeId && !badgeName) {
      warnings.push(`rule #${raw.id} "${raw.name}" has neither badge_type_id nor badge_type_name — skipped`)
      continue
    }

    const level1 = parseStatusList(raw.sync_statuses)
    const requestedLevel2 = parseStatusList(raw.full_profile_statuses)
    const level2 = new Set([...requestedLevel2].filter(status => level1.has(status)))
    const dropped = [...requestedLevel2].filter(status => !level1.has(status))
    if (dropped.length) {
      warnings.push(`rule #${raw.id} "${raw.name}": full_profile_statuses [${dropped.join(', ')}] are not in sync_statuses — ignored`)
    }

    rules.push({
      id: raw.id,
      name: raw.name,
      badgeId,
      badgeName,
      level1,
      level2,
      editionIds: relationIds(raw.festival_editions),
      roleIds: relationIds(raw.user_roles)
    })
  }

  return { rules, warnings }
}

/**
 * Index rules by badge id and by badge name (both lower-cased).
 * Several rules may target the same badge.
 */
export function indexRules (rules) {
  const byBadgeId = new Map()
  const byBadgeName = new Map()
  for (const rule of rules) {
    if (rule.badgeId) {
      if (!byBadgeId.has(rule.badgeId)) byBadgeId.set(rule.badgeId, [])
      byBadgeId.get(rule.badgeId).push(rule)
    }
    if (rule.badgeName) {
      if (!byBadgeName.has(rule.badgeName)) byBadgeName.set(rule.badgeName, [])
      byBadgeName.get(rule.badgeName).push(rule)
    }
  }
  return { byBadgeId, byBadgeName }
}

function rulesForBadge (badge, index) {
  const byId = index.byBadgeId.get(norm(badge.badgeId))
  if (byId && byId.length) return byId
  return index.byBadgeName.get(norm(badge.badgeName)) || []
}

const sortedUnique = values => [...new Set(values)].sort((a, b) => (a > b ? 1 : a < b ? -1 : 0))

/**
 * Evaluate the badges of one accreditation against the rule index.
 *
 * @param {Array<{badgeId:string, badgeName:string, statusText:string}>} badges
 * @param {{byBadgeId:Map, byBadgeName:Map}} index
 * @returns {{level:0|1|2, editionIds:number[], roleIds:number[], matchedRuleIds:number[]}}
 */
export function evaluateBadges (badges, index) {
  let level = 0
  const editionIds = []
  const roleIds = []
  const matchedRuleIds = []

  for (const badge of Array.isArray(badges) ? badges : []) {
    const status = norm(badge.statusText)
    if (!status) continue
    for (const rule of rulesForBadge(badge, index)) {
      if (rule.level2.has(status)) {
        level = 2
        editionIds.push(...rule.editionIds)
        roleIds.push(...rule.roleIds)
        matchedRuleIds.push(rule.id)
      } else if (rule.level1.has(status)) {
        level = Math.max(level, 1)
        matchedRuleIds.push(rule.id)
      }
    }
  }

  return {
    level,
    editionIds: sortedUnique(editionIds),
    roleIds: sortedUnique(roleIds),
    matchedRuleIds: sortedUnique(matchedRuleIds)
  }
}
