/**
 * fiona/explainPerson.js
 *
 * Read-only diagnostic: why does a person the sync manages have, or lack, a festival edition (or role)? For each person it
 * puts side by side
 *   - what Strapi holds (the sync's own fields, the editions on the person, whether the sync attached them),
 *   - what Fiona says (the badges of each accreditation with their status), and
 *   - what the active sync rules make of that (basic level, full profile, or nothing; the editions and roles they give),
 * and ends with a plain sentence. Nothing is written. Badge names, statuses, rule and edition ids are not personal data.
 *
 * No Nuxt auto-imports here so the module is unit-testable.
 */

import { normalizeRules, indexRules, evaluateBadges } from './rules.js'
import { splitIds } from './desiredState.js'

const MAX_PERSONS = 10

const norm = value => String(value ?? '').trim().toLowerCase()
const relationId = value => (value && typeof value === 'object' ? value.id : value)
const numbers = list => [...new Set((Array.isArray(list) ? list : []).map(relationId).filter(id => id !== null && id !== undefined && id !== '').map(Number).filter(Number.isFinite))].sort((a, b) => a - b)
const numbersOf = value => numbers(splitIds(value))
const list = values => values.join(', ')

/**
 * @param {{ personIds: number[], strapi: object, fiona: object, log?: object }} options
 *   personIds = Strapi person ids (at most 10); strapi needs findPersonById and loadRules; fiona needs getAccreditationBadges
 */
export async function explainPersons ({ personIds = [], strapi, fiona, log = console } = {}) {
  const ids = [...new Set((Array.isArray(personIds) ? personIds : []).map(Number).filter(id => Number.isInteger(id) && id > 0))]
  if (!ids.length) throw new Error('explain needs personIds (Strapi person ids)')
  if (ids.length > MAX_PERSONS) throw new Error(`explain handles at most ${MAX_PERSONS} persons per call`)

  const { rules } = normalizeRules(await strapi.loadRules())
  const index = indexRules(rules)
  const ruleById = new Map(rules.map(rule => [rule.id, rule]))
  // the rules that know a badge: by badge id first, by badge name when no rule has that id (as evaluateBadges does)
  const rulesFor = badge => (index.byBadgeId.get(norm(badge.badgeId))?.length ? index.byBadgeId.get(norm(badge.badgeId)) : (index.byBadgeName.get(norm(badge.badgeName)) || []))

  const result = { persons: [], skipped: [] }
  for (const id of ids) {
    let person
    try {
      person = await strapi.findPersonById(id)
    } catch (err) {
      result.skipped.push({ personId: id, reason: `could not be read: ${err?.message || err}` })
      continue
    }
    if (!person) { result.skipped.push({ personId: id, reason: 'not found' }); continue }
    if (!person.fiona_person_id) { result.skipped.push({ personId: id, reason: 'not managed by the Fiona sync' }); continue }

    const accreditationIds = splitIds(person.fiona_accreditation_id)
    const accreditations = []
    const wants = { level: 0, editionIds: new Set(), roleIds: new Set() }
    for (const accreditationId of accreditationIds) {
      let badges
      try {
        badges = await fiona.getAccreditationBadges(accreditationId)
      } catch (err) {
        log.warn?.(`[fiona explain] person #${id} accreditation ${accreditationId}: ${err?.message || err}`)
        accreditations.push({ id: accreditationId, error: err?.message || String(err) })
        continue
      }
      const evaluation = evaluateBadges(badges, index)
      wants.level = Math.max(wants.level, evaluation.level)
      for (const editionId of evaluation.editionIds) wants.editionIds.add(Number(editionId))
      for (const roleId of evaluation.roleIds) wants.roleIds.add(Number(roleId))
      accreditations.push({
        id: accreditationId,
        badges: (Array.isArray(badges) ? badges : []).map((badge) => {
          const status = norm(badge.statusText)
          return {
            name: badge.badgeName,
            id: badge.badgeId,
            status: badge.statusText,
            rules: rulesFor(badge).map((rule) => {
              const full = rule.level2.has(status)
              const result = full ? 'full profile' : (rule.level1.has(status) ? 'basic only' : 'status not listed')
              return { id: rule.id, name: rule.name, result, editionIds: full ? numbers(rule.editionIds) : [], roleIds: full ? numbers(rule.roleIds) : [] }
            })
          }
        })
      })
    }

    const held = numbers(person.festival_editions)
    const attached = numbersOf(person.fiona_attached_edition_ids)
    const attachedBySync = held.filter(editionId => attached.includes(editionId))
    const addedOtherwise = held.filter(editionId => !attached.includes(editionId))
    const wantedEditions = [...wants.editionIds].sort((a, b) => a - b)
    const missingEditionIds = wantedEditions.filter(editionId => !held.includes(editionId))

    result.persons.push({
      personId: person.id,
      name: [person.firstName, person.lastName].filter(Boolean).join(' '),
      sync: {
        fionaPersonId: person.fiona_person_id,
        accreditationIds,
        guestbookIds: splitIds(person.fiona_guestbook_ids),
        attachedEditionIds: attached,
        assignedRoleIds: numbersOf(person.fiona_assigned_role_ids),
        syncedAt: person.fiona_synced_at ?? null,
        unpublishedAt: person.fiona_unpublished_at ?? null,
        userId: relationId(person.user) ? Number(relationId(person.user)) : null,
        public: person.public ?? null,
        createdAt: person.created_at ?? null,
        updatedAt: person.updated_at ?? null
      },
      accreditations,
      wants: { level: wants.level, editionIds: wantedEditions, roleIds: [...wants.roleIds].sort((a, b) => a - b) },
      holds: { editionIds: held, attachedBySync, addedOtherwise },
      missingEditionIds,
      verdict: verdictOf({ accreditations, wants, wantedEditions, missingEditionIds, addedOtherwise, ruleById })
    })
  }
  return result
}

function verdictOf ({ accreditations, wants, wantedEditions, missingEditionIds, addedOtherwise, ruleById }) {
  const unreadable = accreditations.filter(accreditation => accreditation.error)
  if (unreadable.length) return `The badges of accreditation ${list(unreadable.map(a => a.id))} could not be read (${unreadable[0].error}), so nothing can be concluded.`

  const badges = accreditations.flatMap(accreditation => accreditation.badges)
  const withRules = badges.filter(badge => badge.rules.length)
  let text
  if (wants.level === 0) {
    if (withRules.length) {
      const badge = withRules[0]
      text = `The status "${badge.status}" of badge "${badge.name}" is in none of the lists of rule ${list(badge.rules.map(rule => `#${rule.id}`))}: the sync does not want this person through this badge (no basic profile either).`
    } else {
      text = `No active rule knows ${badges.length ? `the badge ${list(badges.map(badge => `"${badge.name}"`))}` : 'any badge of this person'}: the sync does not want this person.`
    }
  } else if (wants.level === 1) {
    const basic = badges.flatMap(badge => badge.rules.filter(rule => rule.result === 'basic only').map(rule => ({ badge, rule })))
    const first = basic[0]
    const full = first ? [...ruleById.get(first.rule.id).level2] : []
    text = `Basic level only: the status "${first?.badge.status}" is in sync_statuses of rule #${first?.rule.id} but not in its full_profile_statuses, so the person is synced without festival editions or roles (by design)${full.length ? `; the full profile starts when the status is one of: ${list(full)}` : ''}.`
  } else if (!wantedEditions.length) {
    const matched = badges.flatMap(badge => badge.rules.filter(rule => rule.result === 'full profile').map(rule => `#${rule.id}`))
    text = `Full profile, but the matching rule(s) ${list([...new Set(matched)])} carry no festival edition, so none is attached.`
  } else if (missingEditionIds.length) {
    text = `The rules give editions ${list(wantedEditions)} but the person is missing ${list(missingEditionIds)}: the sync attaches it on its next run for this person (a full run every night at the set hour; an incremental run only looks at accreditations that changed), or that run's errors say why not.`
  } else {
    text = `The person holds everything the rules give (editions ${list(wantedEditions)}).`
  }
  if (addedOtherwise.length) text += ` Edition(s) ${list(addedOtherwise)} on the person were not attached by the sync (added another way, e.g. by the person's own Creative Gate form or an editor).`
  return text
}
