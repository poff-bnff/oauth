/**
 * fiona/whySynced.js
 *
 * Read-only probe (mode `whySynced` of POST /api/sync/fiona, with `accreditationIds`): for a Fiona accreditation, would the sync create a
 * Strapi person, and if not, why? It uses the sync's own logic: the badges of the accreditation (XAPI), the active rules (Strapi) and
 * evaluateBadges (rules.js). Answers with rule ids and names, badge names and statuses and yes/no facts only: no names, e-mails,
 * contact details or Fiona person ids.
 */
import { normalizeRules, indexRules, evaluateBadges } from './rules.js'

const MAX_ACCREDITATIONS = 5
const norm = value => String(value ?? '').trim().toLowerCase()
const asList = value => (Array.isArray(value) ? value : [])

/** The rules that name this badge: by badge id first, else by badge name (as the sync does). */
function rulesForBadge (badge, index) {
  const byId = index.byBadgeId.get(norm(badge.badgeId))
  if (byId && byId.length) return byId
  return index.byBadgeName.get(norm(badge.badgeName)) || []
}

function verdictFor ({ badges, hasPerson, level, matchedRuleIds, badgeReports, strapiPerson }) {
  if (!badges.length) return 'The accreditation has no badges in Fiona, so no rule can match it.'
  if (!hasPerson) return 'The accreditation has no linked person in Fiona, so the sync skips it.'
  if (level === 0) {
    const withRules = badgeReports.filter(badge => badge.rules.length)
    if (!withRules.length) return `There is no active rule for the badge${badgeReports.length > 1 ? 's' : ''} ${badgeReports.map(badge => `"${badge.name}"`).join(', ')}.`
    const first = withRules[0]
    const rule = first.rules[0]
    return `Badge "${first.name}" has the status "${first.status}", which rule #${rule.id} "${rule.name}" does not accept: it needs one of [${rule.syncStatuses.join(', ')}].`
  }
  const matched = `Matches rule${matchedRuleIds.length > 1 ? 's' : ''} ${matchedRuleIds.map(id => `#${id}`).join(', ')} (level ${level}).`
  if (strapiPerson.exists) return `${matched} The person already has a Strapi person (#${strapiPerson.id}).`
  return `${matched} A Strapi person would be created at the next sync run (every 15 minutes). If it is still missing afterwards, look for: no e-mail in Fiona, a same-name Strapi person (the safeguard holds new persons back: needsDecision), or a conflict.`
}

/**
 * @param {object} options
 * @param {string[]} options.accreditationIds   Fiona accreditation ids, at most five
 * @param {{ getAccreditationBadges: Function, getAccreditation: Function }} options.xapi
 * @param {{ loadRules: Function, findPeopleByFionaIds: Function }} options.strapi
 */
export async function whySyncedReport ({ accreditationIds = [], xapi, strapi } = {}) {
  const { rules, warnings } = normalizeRules(await strapi.loadRules())
  const index = indexRules(rules)
  const accreditations = []

  for (const accreditationId of [...new Set(asList(accreditationIds).map(String).filter(Boolean))].slice(0, MAX_ACCREDITATIONS)) {
    try {
      const badges = asList(await xapi.getAccreditationBadges(accreditationId))
      const detail = await xapi.getAccreditation(accreditationId)
      const evaluation = evaluateBadges(badges, index)

      const badgeReports = badges.map(badge => ({
        name: badge.badgeName,
        status: badge.statusText,
        rules: rulesForBadge(badge, index).map(rule => ({
          id: rule.id,
          name: rule.name,
          syncStatuses: [...rule.level1],
          fullStatuses: [...rule.level2],
          match: rule.level2.has(norm(badge.statusText)) ? 'full' : (rule.level1.has(norm(badge.statusText)) ? 'sync' : 'none')
        }))
      }))

      let strapiPerson = { exists: false }
      if (detail?.personId) {
        const person = asList(await strapi.findPeopleByFionaIds([detail.personId]))[0]
        if (person) strapiPerson = { exists: true, id: person.id, public: person.public === true }
      }

      accreditations.push({
        accreditationId,
        guestbookId: detail?.guestbookId ?? null,
        badges: badgeReports,
        level: evaluation.level,
        matchedRuleIds: evaluation.matchedRuleIds,
        fullRuleIds: evaluation.fullRuleIds,
        strapiPerson,
        verdict: verdictFor({ badges, hasPerson: Boolean(detail?.personId), level: evaluation.level, matchedRuleIds: evaluation.matchedRuleIds, badgeReports, strapiPerson })
      })
    } catch (err) {
      accreditations.push({ accreditationId, error: String(err?.message || err) })
    }
  }

  return { rulesActive: rules.length, warnings, accreditations }
}
