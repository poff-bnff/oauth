/**
 * fiona/sync.js
 *
 * The Fiona → Strapi accredited-person sync as a desired-state computation.
 *
 * Phases (see the POFF-166 plan):
 *   1. load + normalise the `fiona-sync-rule` records
 *   2. scan the guestbooks of the active festival editions
 *   3. evaluate every accreditation's badges → desired state per Fiona person
 *   4. plan removals for persons the sync manages but no longer wants
 *   5. upsert desired persons (user, user-profile, person, editions, roles)
 *   6. apply the remaining removals (downgrade / unpublish)
 *   7. trigger per-person site builds within the per-run cap
 *
 * All external access goes through `deps.fiona` and `deps.strapi` so the
 * whole flow is testable with in-memory fakes. No Nuxt globals here.
 */

import { normalizeRules, indexRules, evaluateBadges } from './rules.js'
import { mergeDesired, planRemovals, splitIds } from './desiredState.js'
import { buildPersonPayload } from './personMapper.js'

const norm = value => String(value ?? '').trim().toLowerCase()
const numericSort = list => [...list].sort((a, b) => a - b)
const uniqueNumbers = list => numericSort(new Set([...list].map(Number)))
const joinIds = list => [...list].map(String).sort().join(',')
const relationId = value => (value && typeof value === 'object') ? value.id : value
const relationIds = list => (Array.isArray(list) ? list : []).map(relationId).filter(id => id !== null && id !== undefined).map(Number)
const sameIds = (a, b) => joinIds(uniqueNumbers(a)) === joinIds(uniqueNumbers(b))

function newStats (dryRun) {
  return {
    dryRun,
    durationSec: 0,
    guestbooks: { active: 0, scanned: 0, failed: 0 },
    rules: { active: 0, mapped: 0, unmapped: 0 },
    accreditations: { seen: 0, matched: 0, errors: 0 },
    persons: { desired: 0, created: 0, updated: 0, unchanged: 0, downgraded: 0, unpublished: 0, conflicts: 0, skippedNoEmail: 0 },
    editions: { attached: 0, detached: 0 },
    users: { created: 0, linked: 0 },
    profiles: { created: 0 },
    build: { triggered: false, ids: [] },
    removals: { skipped: false, reason: null },
    editionsWithGuestbook: [],
    guestbookBadges: {},
    badgeStatuses: {},
    warnings: [],
    errors: 0,
    errorMessages: []
  }
}

/** Human-readable error text including HTTP status and response body when present. */
function describeError (err) {
  if (!err) return 'unknown error'
  const status = err.statusCode || err.status || err.response?.status
  const body = err.data ?? err.response?._data
  let text = err.message || String(err)
  if (status) text = `HTTP ${status} ${text}`
  if (body !== undefined && body !== null) {
    const snippet = typeof body === 'string' ? body : JSON.stringify(body)
    if (snippet && !text.includes(snippet)) text += ` — ${snippet.slice(0, 300)}`
  }
  return text
}

/** Keys of `payload` whose value differs from `existing` (relations compared by id). */
function changedFields (existing, payload) {
  const changed = []
  for (const [key, value] of Object.entries(payload)) {
    if (key === 'skipbuild' || key === 'fiona_synced_at') continue
    const current = existing[key]
    if (Array.isArray(value)) {
      if (!sameIds(relationIds(current), value)) changed.push(key)
      continue
    }
    if (key === 'picture') {
      if (Number(relationId(current)) !== Number(value)) changed.push(key)
      continue
    }
    const a = current === undefined ? null : current
    const b = value === undefined ? null : value
    if (a !== b) changed.push(key)
  }
  return changed
}

export async function runSync ({ dryRun = false, force = false } = {}, deps) {
  const { fiona, strapi, config = {} } = deps
  const log = deps.log || console
  const now = deps.now || (() => new Date())
  const maxRemovals = Number.isFinite(Number(config.maxRemovals)) && config.maxRemovals !== undefined ? Number(config.maxRemovals) : 50
  const maxBuildsPerRun = Number.isFinite(Number(config.maxBuildsPerRun)) && config.maxBuildsPerRun !== undefined ? Number(config.maxBuildsPerRun) : 20
  const startedAt = Date.now()
  const stats = newStats(dryRun)
  const would = dryRun ? 'DRY RUN would ' : ''

  const warn = (message) => { stats.warnings.push(message); log.warn(message) }
  const fail = (message, err) => {
    stats.errors++
    const line = `${message}: ${describeError(err)}`
    if (stats.errorMessages.length < 50) stats.errorMessages.push(line)
    log.error(line)
  }
  const finish = () => { stats.durationSec = Number(((Date.now() - startedAt) / 1000).toFixed(1)); return stats }

  // Why is no guestbook active? List every edition with a guestbook id and its window.
  async function explainInactiveEditions () {
    const today = now().toISOString().slice(0, 10)
    let editions = []
    try {
      editions = await strapi.listEditionsWithGuestbook()
    } catch (err) {
      warn(`could not list editions with a guestbook id: ${err.message}`)
      return
    }
    if (!editions.length) {
      warn('no festival edition has a guestbook_id — nothing to scan')
      return
    }
    stats.editionsWithGuestbook = editions.map((edition) => {
      const from = edition.validFrom ? String(edition.validFrom).slice(0, 10) : null
      const until = edition.validUntil ? String(edition.validUntil).slice(0, 10) : null
      let reason = null
      if (!from && !until) reason = 'validFrom and validUntil are not set'
      else if (!from) reason = 'validFrom is not set'
      else if (!until) reason = 'validUntil is not set'
      else if (!(from < today)) reason = `validFrom is not before today (${today})`
      else if (!(until > today)) reason = `validUntil is not after today (${today})`
      const active = reason === null
      const line = `edition #${edition.id} "${edition.name}" guestbook ${edition.guestbookId} validFrom ${edition.validFrom || '-'} validUntil ${edition.validUntil || '-'}`
      if (active) log.info(`${line} — active`)
      else warn(`${line} — not active: ${reason}`)
      return { ...edition, active, reason }
    })
  }

  log.info(`▶ Starting Fiona sync${dryRun ? ' (DRY RUN)' : ''} at ${now().toISOString()}`)

  // 1. Rules -----------------------------------------------------------------
  const { rules, warnings } = normalizeRules(await strapi.loadRules())
  warnings.forEach(warn)
  stats.rules.active = rules.length
  const discoveryOnly = rules.length === 0
  if (discoveryOnly) {
    warn('no active fiona-sync-rules — nothing to sync, removal phase skipped')
    stats.removals = { skipped: true, reason: 'no active rules' }
    if (!dryRun) return finish()
    log.info('DRY RUN with no rules: scanning the active guestbooks for badge discovery only')
  }
  const index = indexRules(rules)

  // 2. Guestbooks ------------------------------------------------------------
  const guestbookIds = await strapi.getActiveGuestbookIds()
  stats.guestbooks.active = guestbookIds.length
  if (!guestbookIds.length) await explainInactiveEditions()
  const scanned = new Map()
  for (const guestbookId of guestbookIds) {
    try {
      const [badges, accreditations] = await Promise.all([
        fiona.listGuestbookBadges(guestbookId),
        fiona.listAccreditations(guestbookId)
      ])
      scanned.set(guestbookId, { badges, accreditations })
    } catch (err) {
      stats.guestbooks.failed++
      fail(`guestbook ${guestbookId} could not be fetched — its persons are left untouched`, err)
    }
  }
  stats.guestbooks.scanned = scanned.size

  const badgeIdsInScanned = new Set()
  const badgeNamesInScanned = new Set()
  const badgeNameById = new Map()
  for (const [guestbookId, { badges }] of scanned) {
    for (const badge of badges) {
      if (badge.id) badgeIdsInScanned.add(norm(badge.id))
      if (badge.name) badgeNamesInScanned.add(norm(badge.name))
      if (badge.id && badge.name) badgeNameById.set(norm(badge.id), badge.name)
    }
    stats.guestbookBadges[guestbookId] = badges.map(badge => `${badge.name} (${badge.id})`)
    log.info(`Guestbook ${guestbookId} badges: ${stats.guestbookBadges[guestbookId].join(', ') || '(none)'}`)
  }
  const mappedRules = rules.filter(rule =>
    (rule.badgeId && badgeIdsInScanned.has(rule.badgeId)) || (rule.badgeName && badgeNamesInScanned.has(rule.badgeName))
  )
  stats.rules.mapped = mappedRules.length
  stats.rules.unmapped = rules.length - mappedRules.length
  for (const rule of rules) {
    const mapped = mappedRules.includes(rule)
    const line = `rule #${rule.id} "${rule.name}" badge ${rule.badgeId || rule.badgeName} sync=[${[...rule.level1].join(', ')}] full=[${[...rule.level2].join(', ')}] editions=[${rule.editionIds.join(', ')}] roles=[${rule.roleIds.join(', ')}]`
    if (mapped) log.info(line)
    else warn(`${line} — matches no badge in the active guestbooks`)
  }
  const editionIdsInScope = new Set(mappedRules.flatMap(rule => rule.editionIds))
  const roleIdsInScope = new Set(mappedRules.flatMap(rule => rule.roleIds))

  // 3. Desired state ---------------------------------------------------------
  const desired = new Map()
  const privacy = new Map()
  const erroredAccreditationIds = new Set()
  for (const [guestbookId, { accreditations }] of scanned) {
    stats.accreditations.seen += accreditations.length
    let matched = 0
    const seenHere = new Map()
    for (const accreditation of accreditations) {
      try {
        const badges = await fiona.getAccreditationBadges(accreditation.id)
        for (const badge of badges) {
          const badgeName = badge.badgeName || badgeNameById.get(norm(badge.badgeId)) || '?'
          const badgeId = badge.badgeId || '?'
          const label = `${badgeName} (${badgeId})`
          const status = norm(badge.statusText) || '(no status)'
          const counts = stats.badgeStatuses[label] || (stats.badgeStatuses[label] = {})
          counts[status] = (counts[status] || 0) + 1
          if (!seenHere.has(label)) seenHere.set(label, { badgeName, badgeId, counts: new Map() })
          const here = seenHere.get(label).counts
          here.set(status, (here.get(status) || 0) + 1)
        }
        const evaluation = evaluateBadges(badges, index)
        if (evaluation.level === 0) continue
        const detail = await fiona.getAccreditation(accreditation.id)
        if (!detail.personId) {
          warn(`accreditation ${accreditation.id} has no linked person — skipped`)
          continue
        }
        mergeDesired(desired, detail.personId, { guestbookId, accreditationId: accreditation.id, evaluation })
        privacy.set(detail.personId, Boolean(privacy.get(detail.personId)) || detail.noPublicationOfContactDetails === true)
        matched++
      } catch (err) {
        stats.accreditations.errors++
        erroredAccreditationIds.add(String(accreditation.id))
        fail(`accreditation ${accreditation.id}`, err)
      }
    }
    stats.accreditations.matched += matched
    log.info(`Guestbook ${guestbookId}: ${accreditations.length} accreditations, ${matched} matched`)
    for (const { badgeName, badgeId, counts } of seenHere.values()) {
      const summary = [...counts]
        .sort((a, b) => b[1] - a[1] || (a[0] > b[0] ? 1 : -1))
        .map(([status, n]) => `${status}=${n}`)
        .join(', ')
      log.info(`Guestbook ${guestbookId} badge "${badgeName}" (${badgeId}) statuses: ${summary}`)
    }
  }
  stats.persons.desired = desired.size
  if (discoveryOnly) return finish()

  // 4. Plan removals (from a snapshot taken before any write) ----------------
  const managedPeople = await strapi.findManagedPeople()
  const managedByFionaId = new Map(managedPeople.map(person => [person.fiona_person_id, person]))
  const erroredPersonIds = new Set(
    managedPeople
      .filter(person => splitIds(person.fiona_accreditation_id).some(id => erroredAccreditationIds.has(id)))
      .map(person => person.fiona_person_id)
  )
  const plan = planRemovals({
    managedPeople,
    desired,
    scannedGuestbookIds: new Set(scanned.keys()),
    editionIdsInScope,
    roleIdsInScope,
    erroredPersonIds,
    rulesMapped: mappedRules.length > 0,
    maxRemovals,
    force
  })
  stats.removals = { skipped: plan.skipped, reason: plan.reason }
  if (plan.skipped) warn(plan.reason)
  const actionByFionaId = new Map(plan.actions.map(action => [action.fionaPersonId, action]))

  const buildIds = []

  // 5. Upsert desired persons -----------------------------------------------
  for (const [fionaPersonId, want] of desired) {
    try {
      const fionaPerson = await fiona.getPerson(fionaPersonId)

      // user resolution: MyPoff link → existing person's user → find/register by email
      let user = null
      const myPoffUserId = await fiona.getMyPoffUserId(fionaPersonId)
      if (myPoffUserId) user = await strapi.getUser(myPoffUserId)

      let existing = managedByFionaId.get(fionaPersonId) || await strapi.findPersonByFionaId(fionaPersonId)
      const userPersonId = user?.person ? Number(relationId(user.person)) : null
      if (existing && userPersonId && userPersonId !== Number(existing.id)) {
        stats.persons.conflicts++
        log.error(`person ${fionaPersonId}: fiona_person_id points to person #${existing.id} but its MyPoff user #${user.id} owns person #${userPersonId} — skipped`)
        continue
      }
      if (!existing && userPersonId) existing = await strapi.findPersonById(userPersonId)
      if (!user && existing?.user) user = await strapi.getUser(relationId(existing.user))

      const contactEmail = fionaPerson.email || user?.email || null
      if (!contactEmail) {
        stats.persons.skippedNoEmail++
        warn(`person ${fionaPersonId} (${fionaPerson.firstName} ${fionaPerson.lastName}) has no email — skipped`)
        continue
      }
      if (!existing) existing = await strapi.findPersonByEmail(contactEmail)
      if (existing?.fiona_person_id && existing.fiona_person_id !== fionaPersonId) {
        stats.persons.conflicts++
        log.error(`person ${fionaPersonId}: email ${contactEmail} belongs to person #${existing.id} synced from Fiona person ${existing.fiona_person_id} — skipped`)
        continue
      }

      const action = actionByFionaId.get(fionaPersonId)
      const detach = action ? action.detachEditionIds : []
      const removeRoles = action ? action.removeRoleIds : []
      const currentEditionIds = relationIds(existing?.festival_editions)
      const editionIds = uniqueNumbers([...currentEditionIds.filter(id => !detach.includes(id)), ...want.editionIds])
      const newlyAttached = [...want.editionIds].filter(id => !currentEditionIds.includes(Number(id)))

      const payload = buildPersonPayload({
        fionaPerson,
        level: want.level,
        contactEmail,
        noPublicationOfContactDetails: privacy.get(fionaPersonId) === true
      })
      Object.assign(payload, {
        fiona_person_id: fionaPersonId,
        fiona_accreditation_id: joinIds(want.accreditationIds),
        fiona_guestbook_ids: joinIds(want.guestbookIds),
        fiona_attached_edition_ids: uniqueNumbers(want.editionIds).join(','),
        fiona_assigned_role_ids: uniqueNumbers(want.roleIds).join(','),
        festival_editions: editionIds
      })
      if (existing?.fiona_unpublished_at) {
        payload.fiona_unpublished_at = null
        payload.show_in_cg_search = true
      }

      let photo = null
      if (!existing?.picture) {
        try {
          photo = await fiona.getPersonPhoto(fionaPersonId)
        } catch (err) {
          warn(`person ${fionaPersonId}: photo unavailable (${err.message})`)
        }
      }

      const changed = existing ? changedFields(existing, payload) : null
      const summary = `person ${fionaPersonId} ${fionaPerson.firstName} ${fionaPerson.lastName} level ${want.level} editions=[${editionIds.join(', ')}] roles=[${[...want.roleIds].join(', ')}]`

      if (dryRun) {
        if (!existing) { stats.persons.created++; log.info(`${would}CREATE ${summary}`) } else if (changed.length) { stats.persons.updated++; log.info(`${would}UPDATE person #${existing.id} (${changed.join(', ')}) ${summary}`) } else { stats.persons.unchanged++ }
        if (action) log.info(`${would}${action.type} person #${existing?.id} -editions=[${detach.join(', ')}] -roles=[${removeRoles.join(', ')}]`)
        stats.editions.attached += newlyAttached.length
        stats.editions.detached += detach.length
        continue
      }

      if (photo) {
        const fileId = await strapi.uploadPhoto(photo.buffer, photo.filename)
        if (fileId) payload.picture = fileId
      }

      let person = existing
      let personChanged = false
      if (!existing) {
        const { festival_editions: editions, ...createPayload } = payload
        person = await strapi.createPerson({ ...createPayload, fiona_synced_at: now().toISOString(), skipbuild: true })
        if (editions.length) person = await strapi.updatePerson(person.id, { festival_editions: editions, skipbuild: true })
        stats.persons.created++
        personChanged = true
        log.info(`CREATED #${person.id} ${summary}`)
      } else if (changed.length) {
        person = await strapi.updatePerson(existing.id, { ...payload, fiona_synced_at: now().toISOString(), skipbuild: true })
        stats.persons.updated++
        personChanged = true
        log.info(`UPDATED #${person.id} (${changed.join(', ')}) ${summary}`)
      } else {
        stats.persons.unchanged++
      }
      stats.editions.attached += newlyAttached.length
      stats.editions.detached += detach.length
      if (action) stats.persons.downgraded++

      if (!user) {
        const result = await strapi.findOrRegisterUser(contactEmail)
        user = result.user
        if (result.created) stats.users.created++
      }
      if (Number(relationId(user.person)) !== Number(person.id)) {
        await strapi.linkPersonToUser(person.id, user.id)
        stats.users.linked++
      }
      const profileCreated = await strapi.ensureUserProfile(user, {
        email: contactEmail,
        firstName: fionaPerson.firstName || null,
        lastName: fionaPerson.lastName || null,
        ...(fionaPerson.phone ? { phoneNr: fionaPerson.phone } : {})
      })
      if (profileCreated) stats.profiles.created++

      if (want.roleIds.size || removeRoles.length) {
        const currentRoles = await strapi.getUserRoleIds(user.id)
        const nextRoles = uniqueNumbers([...currentRoles.filter(id => !removeRoles.includes(Number(id))), ...want.roleIds])
        if (!sameIds(currentRoles, nextRoles)) await strapi.setUserRoles(user.id, nextRoles)
      }

      if ((want.level === 2 && personChanged) || detach.length) buildIds.push(Number(person.id))
    } catch (err) {
      fail(`person ${fionaPersonId}`, err)
    }
  }

  // 6. Remaining removals (persons no longer desired) ------------------------
  for (const action of plan.actions) {
    if (desired.has(action.fionaPersonId)) continue
    const person = managedByFionaId.get(action.fionaPersonId)
    if (!person) continue
    try {
      const label = `${action.type} person #${person.id} (${action.fionaPersonId}) -editions=[${action.detachEditionIds.join(', ')}] -roles=[${action.removeRoleIds.join(', ')}]`
      if (action.type === 'UNPUBLISH') stats.persons.unpublished++
      else stats.persons.downgraded++
      stats.editions.detached += action.detachEditionIds.length
      if (dryRun) { log.info(`${would}${label}`); continue }

      const payload = {
        festival_editions: action.remainingEditionIds,
        fiona_attached_edition_ids: action.remainingAttachedEditionIds.join(','),
        fiona_assigned_role_ids: action.remainingAssignedRoleIds.join(','),
        fiona_guestbook_ids: action.remainingGuestbookIds.join(','),
        skipbuild: true
      }
      if (action.type === 'UNPUBLISH') {
        payload.show_in_cg_search = false
        payload.fiona_unpublished_at = now().toISOString()
      }
      await strapi.updatePerson(person.id, payload)

      const userId = relationId(person.user)
      if (action.removeRoleIds.length && userId) {
        const currentRoles = await strapi.getUserRoleIds(userId)
        const nextRoles = uniqueNumbers(currentRoles.filter(id => !action.removeRoleIds.includes(Number(id))))
        if (!sameIds(currentRoles, nextRoles)) await strapi.setUserRoles(userId, nextRoles)
      }
      buildIds.push(Number(person.id))
      log.info(label)
    } catch (err) {
      fail(`removal for person #${person.id}`, err)
    }
  }

  // 7. Builds ----------------------------------------------------------------
  stats.build.ids = uniqueNumbers(buildIds)
  if (!dryRun && stats.build.ids.length) {
    if (stats.build.ids.length <= maxBuildsPerRun) {
      for (const id of stats.build.ids) {
        try {
          await strapi.updatePerson(id, { fiona_synced_at: now().toISOString() }) // no skipbuild → per-person site build
        } catch (err) {
          fail(`build touch for person #${id}`, err)
        }
      }
      stats.build.triggered = true
    } else {
      warn(`${stats.build.ids.length} persons changed, above the per-run build cap of ${maxBuildsPerRun} — run a full build + publish from the Strapi admin`)
    }
  }

  log.info(`✅ Done in ${((Date.now() - startedAt) / 1000).toFixed(1)}s — ${JSON.stringify({ ...stats, warnings: stats.warnings.length })}`)
  return finish()
}
