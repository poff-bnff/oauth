/**
 * fiona/desiredState.js
 *
 * Pure helpers for the "desired state" half of the Fiona sync:
 *   - mergeDesired()  aggregates badge evaluations per Fiona person across
 *                     accreditations and guestbooks
 *   - planRemovals()  diffs the persons Strapi already manages against that
 *                     desired state and produces DOWNGRADE / UNPUBLISH actions
 *
 * No Nuxt auto-imports here so the module is unit-testable.
 */

export const splitIds = value => String(value ?? '')
  .split(',')
  .map(part => part.trim())
  .filter(Boolean)

const toNumberIds = list => splitIds(list).map(Number).filter(n => Number.isFinite(n))

const relationIds = list => (Array.isArray(list) ? list : [])
  .map(item => (item && typeof item === 'object' ? item.id : item))
  .filter(id => id !== null && id !== undefined)
  .map(Number)

const numericSort = list => [...list].sort((a, b) => a - b)
const stringSort = list => [...list].sort()

/**
 * Merge one accreditation's evaluation into the per-person desired state.
 * Level-0 evaluations are ignored (the person is simply not desired via this
 * accreditation). Highest level wins; editions, roles, guestbooks and
 * accreditation ids are unioned.
 */
export function mergeDesired (desired, fionaPersonId, { guestbookId, accreditationId, evaluation }) {
  if (!fionaPersonId || !evaluation || !(evaluation.level > 0)) return desired

  let entry = desired.get(fionaPersonId)
  if (!entry) {
    entry = {
      level: 0,
      guestbookIds: new Set(),
      accreditationIds: new Set(),
      editionIds: new Set(),
      roleIds: new Set(),
      matchedRuleIds: new Set()
    }
    desired.set(fionaPersonId, entry)
  }

  entry.level = Math.max(entry.level, evaluation.level)
  if (guestbookId) entry.guestbookIds.add(guestbookId)
  if (accreditationId) entry.accreditationIds.add(accreditationId)
  for (const id of evaluation.editionIds || []) entry.editionIds.add(Number(id))
  for (const id of evaluation.roleIds || []) entry.roleIds.add(Number(id))
  for (const id of evaluation.matchedRuleIds || []) entry.matchedRuleIds.add(id)
  return desired
}

/**
 * Diff sync-managed persons against the desired state.
 *
 * @param {object} params
 * @param {Array}  params.managedPeople        Strapi persons with fiona_* fields and festival_editions populated
 * @param {Map}    params.desired              fionaPersonId → { level, editionIds:Set, roleIds:Set, guestbookIds:Set }
 * @param {Set}    params.scannedGuestbookIds  guestbooks whose accreditations and badges were fetched OK this run
 * @param {Set}    params.editionIdsInScope    editions referenced by rules that matched a scanned guestbook
 * @param {Set}    params.roleIdsInScope       roles referenced by those rules
 * @param {Set}    [params.erroredPersonIds]   Fiona person ids whose fetch failed this run (never removed)
 * @param {boolean}[params.rulesMapped=true]   false when no active rule maps to any scanned guestbook
 * @param {number} [params.maxRemovals=50]     cap on UNPUBLISH actions per run
 * @param {boolean}[params.force=false]        override the cap
 * @returns {{ actions: Array, skipped: boolean, reason: string|null }}
 */
export function planRemovals ({
  managedPeople,
  desired,
  scannedGuestbookIds,
  editionIdsInScope,
  roleIdsInScope,
  erroredPersonIds = new Set(),
  rulesMapped = true,
  maxRemovals = 50,
  force = false
}) {
  if (!rulesMapped) {
    return { actions: [], skipped: true, reason: 'no active rule maps to a scanned guestbook — removal phase skipped' }
  }

  const actions = []

  for (const person of Array.isArray(managedPeople) ? managedPeople : []) {
    const fionaPersonId = person?.fiona_person_id
    if (!fionaPersonId) continue
    if (erroredPersonIds.has(fionaPersonId)) continue

    const personGuestbooks = splitIds(person.fiona_guestbook_ids)
    const scanned = personGuestbooks.filter(id => scannedGuestbookIds.has(id))
    if (!scanned.length) continue
    const unscanned = personGuestbooks.filter(id => !scannedGuestbookIds.has(id))

    const wanted = desired.get(fionaPersonId) || null
    const wantEditions = wanted ? wanted.editionIds : new Set()
    const wantRoles = wanted ? wanted.roleIds : new Set()

    const attached = toNumberIds(person.fiona_attached_edition_ids)
    const assignedRoles = toNumberIds(person.fiona_assigned_role_ids)

    const detachEditionIds = numericSort(attached.filter(id => editionIdsInScope.has(id) && !wantEditions.has(id)))
    const removeRoleIds = numericSort(assignedRoles.filter(id => roleIdsInScope.has(id) && !wantRoles.has(id)))

    const currentEditions = relationIds(person.festival_editions)
    const remainingEditionIds = numericSort(currentEditions.filter(id => !detachEditionIds.includes(id)))
    const remainingAttachedEditionIds = numericSort(attached.filter(id => !detachEditionIds.includes(id)))
    const remainingAssignedRoleIds = numericSort(assignedRoles.filter(id => !removeRoleIds.includes(id)))
    const remainingGuestbookIds = stringSort(new Set([...unscanned, ...(wanted ? wanted.guestbookIds : [])]))

    const guestbooksChanged = remainingGuestbookIds.join(',') !== stringSort(personGuestbooks).join(',')
    const nothingToDo = !detachEditionIds.length && !removeRoleIds.length && !guestbooksChanged

    let type
    if (wanted) {
      if (nothingToDo) continue
      type = 'DOWNGRADE'
    } else if (unscanned.length) {
      if (nothingToDo) continue
      type = 'DOWNGRADE'
    } else {
      type = 'UNPUBLISH'
    }

    actions.push({
      type,
      personId: person.id,
      fionaPersonId,
      detachEditionIds,
      removeRoleIds,
      remainingEditionIds,
      remainingAttachedEditionIds,
      remainingAssignedRoleIds,
      remainingGuestbookIds
    })
  }

  const unpublishCount = actions.filter(action => action.type === 'UNPUBLISH').length
  if (unpublishCount > maxRemovals && !force) {
    return {
      actions: [],
      skipped: true,
      reason: `${unpublishCount} unpublish actions exceed the cap of ${maxRemovals} — removal phase skipped (pass force:true to override)`
    }
  }

  return { actions, skipped: false, reason: null }
}
