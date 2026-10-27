/**
 * fiona/sync.js
 *
 * The Fiona → Strapi accredited-person sync as a desired-state computation.
 *
 * Modes:
 *   full         scan every accreditation of the active guestbooks, reconcile,
 *                may downgrade / unpublish persons that stopped matching
 *   incremental  read the Publication API mutations feed since the job's
 *                cursor, re-evaluate only the affected accreditations and,
 *                for affected persons, all their accreditations — so those
 *                persons are reconciled completely while everyone else is
 *                left untouched
 *   auto         decide from the `fiona-sync-job` entry (enabled, interval,
 *                nightly full-run hour) whether a full, an incremental or no
 *                run is due — what the cron calls every minute
 *
 * Phases: rules → active guestbooks + badge lists → managed-person snapshot →
 * desired state (full scan or mutations) → removal plan → upserts → remaining
 * removals → per-rule site builds (limit per run, waiting list in the job entry) → job state.
 *
 * All external access goes through `deps.fiona` and `deps.strapi` so the
 * whole flow is testable with in-memory fakes. No Nuxt globals here.
 */

import { normalizeRules, indexRules, evaluateBadges } from './rules.js'
import { mergeDesired, planRemovals, splitIds } from './desiredState.js'
import { buildPersonPayload, valuesToClear } from './personMapper.js'
import { headshotFileName } from './photoName.js'

export const JOB_KEY = 'accreditations'
const RELEVANT_ENTITIES = new Set(['Accreditation', 'AccreditationBadge', 'Person'])
const MUTATION_OVERLAP_MS = 5 * 60 * 1000
const JOB_TIME_ZONE = 'Europe/Tallinn'

const norm = value => String(value ?? '').trim().toLowerCase()
const numericSort = list => [...list].sort((a, b) => a - b)
const uniqueNumbers = list => numericSort(new Set([...list].map(Number)))
const joinIds = list => [...list].map(String).sort().join(',')
const relationId = value => (value && typeof value === 'object') ? value.id : value
const relationIds = list => (Array.isArray(list) ? list : []).map(relationId).filter(id => id !== null && id !== undefined).map(Number)
const sameIds = (a, b) => joinIds(uniqueNumbers(a)) === joinIds(uniqueNumbers(b))
const isNotFound = err => err?.statusCode === 404 || err?.status === 404 || err?.response?.status === 404

/** The job's build_queue (JSON): [{ personId, ruleIds }], tolerant of anything else. */
function normalizeBuildQueue (raw) {
  let list = raw
  if (typeof raw === 'string') {
    try { list = JSON.parse(raw) } catch (err) { return [] }
  }
  if (!Array.isArray(list)) return []
  const byPerson = new Map()
  for (const item of list) {
    const personId = Number(item?.personId)
    if (!Number.isInteger(personId) || personId <= 0) continue
    const ruleIds = (Array.isArray(item.ruleIds) ? item.ruleIds : []).map(Number).filter(Number.isFinite)
    const entry = byPerson.get(personId) || { personId, ruleIds: [] }
    entry.ruleIds = uniqueNumbers([...entry.ruleIds, ...ruleIds])
    byPerson.set(personId, entry)
  }
  return [...byPerson.values()]
}

/** Waiting list plus this run's candidates; only rules that still build count, entries without any are dropped. */
function mergeBuildQueue (queue, candidates, buildRules) {
  const merged = normalizeBuildQueue([...queue, ...candidates])
  return merged
    .map(entry => ({ personId: entry.personId, ruleIds: entry.ruleIds.filter(id => buildRules.has(id)) }))
    .filter(entry => entry.ruleIds.length)
}

function newStats (dryRun, mode) {
  return {
    dryRun,
    mode,
    skipped: false,
    reason: null,
    durationSec: 0,
    guestbooks: { active: 0, scanned: 0, failed: 0 },
    rules: { active: 0, mapped: 0, unmapped: 0 },
    accreditations: { seen: 0, matched: 0, errors: 0 },
    persons: { desired: 0, created: 0, updated: 0, unchanged: 0, downgraded: 0, unpublished: 0, conflicts: 0, skippedNoEmail: 0 },
    editions: { attached: 0, detached: 0 },
    users: { created: 0, linked: 0, confirmed: 0, unconfirmedSeen: 0, confirmedFieldMissing: 0 },
    profiles: { created: 0, updated: 0 },
    privacy: { emailWithheld: 0, phoneWithheld: 0, emailCleared: 0, phoneCleared: 0 },
    customFieldKeys: {},
    ruleRoles: [],
    build: { triggered: false, ids: [], queued: 0, candidates: 0, removedWithoutBuild: [] },
    switches: { unpublishedPhotos: false, unpublishedBios: false },
    backlog: { cap: 0, more: false },
    photos: { published: 0, headshot: 0, missing: [] },
    bios: { accreditation: 0, missing: [] },
    removals: { skipped: false, reason: null },
    incremental: null,
    editionsWithGuestbook: [],
    knownGuestbooks: null,
    guestbookBadges: {},
    badgeStatuses: {},
    warnings: [],
    errors: 0,
    errorMessages: [],
    dryRunActions: []
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

/**
 * The roles the rules grant, with their validity. Strapi lets a person publish, and sends its Creative Gate
 * "created" email, only while the user holds a role that is still valid: a role without a valid_to date counts
 * only with an active Creative Gate product, which synced users do not have. Warns about such roles.
 * A role object without the valid_to key at all (plain ids, test data) is not judged.
 */
function reportRoleValidity (rawRules, now, stats, warn) {
  const seen = new Map()
  for (const rule of Array.isArray(rawRules) ? rawRules : []) {
    for (const role of Array.isArray(rule?.user_roles) ? rule.user_roles : []) {
      if (role && typeof role === 'object' && role.id !== undefined && !seen.has(Number(role.id))) seen.set(Number(role.id), role)
    }
  }
  stats.ruleRoles = [...seen.values()].map(role => ({ id: Number(role.id), name: role.name ?? null, validFrom: role.valid_from ?? null, validTo: role.valid_to ?? null }))
  for (const role of seen.values()) {
    if (!('valid_to' in role)) continue
    const label = `role #${role.id} "${role.name ?? ''}"`
    if (!role.valid_to) warn(`${label} has no valid_to date: users get the publisher right only with an active Creative Gate product, so persons stay unpublished and no "created" email goes out`)
    else if (new Date(role.valid_to) < now) warn(`${label} expired on ${role.valid_to}: no publisher right and no "created" email`)
  }
}

const COMPARED_FIELDS = ['firstName', 'lastName', 'firstNameLastName', 'eMail', 'phoneNr', 'bio_en']
const clip = (value) => {
  if (value === undefined || value === null) return null
  const text = String(value)
  return text.length > 300 ? `${text.slice(0, 300)}…` : text
}

/** Dry run only: Strapi value next to Fiona value for each content field that would change. */
function contentDiff (existing, payload, changed) {
  const diff = {}
  for (const key of COMPARED_FIELDS) {
    if (changed.includes(key)) diff[key] = { strapi: clip(existing[key]), fiona: clip(payload[key]) }
  }
  return diff
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

/** Local (Europe/Tallinn) calendar date and hour of an instant. */
function localDateAndHour (date) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: JOB_TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23'
  }).formatToParts(date)
  const get = type => parts.find(part => part.type === type)?.value
  return { date: `${get('year')}-${get('month')}-${get('day')}`, hour: Number(get('hour')) }
}

/** What should an `auto` invocation do, given the job entry? */
const BACKLOG_GAP_MINUTES = 2
const BACKLOG_RECENT_HOURS = 6 // a person written within this time by the run before is left alone in a backlog run

export function decideAutoMode (job, nowDate) {
  if (!job) return { skipped: true, reason: `no fiona-sync-job entry with key "${JOB_KEY}" — create one in Strapi admin` }
  if (job.enabled === false) return { skipped: true, reason: 'job is disabled (enabled = false)' }

  // The last run stopped at its cap of persons written (backlog.more): carry on with a full run two minutes later,
  // without waiting for the interval or for the night, until a run writes fewer persons than the cap.
  if (job.last_stats?.backlog?.more === true) {
    const lastRun = Math.max(job.last_full_run_at ? new Date(job.last_full_run_at).getTime() : 0, job.last_incremental_run_at ? new Date(job.last_incremental_run_at).getTime() : 0)
    const dueAt = lastRun + BACKLOG_GAP_MINUTES * 60 * 1000
    if (nowDate.getTime() >= dueAt) return { skipped: false, mode: 'full', backlog: true }
    return { skipped: true, reason: `backlog — the next run at ${new Date(dueAt).toISOString()}` }
  }

  const hour = Number(job.full_run_hour)
  if (job.full_run_hour !== null && job.full_run_hour !== undefined && job.full_run_hour !== '' && Number.isFinite(hour)) {
    const today = localDateAndHour(nowDate)
    const lastFull = job.last_full_run_at ? localDateAndHour(new Date(job.last_full_run_at)).date : null
    if (today.hour >= hour && lastFull !== today.date) return { skipped: false, mode: 'full' }
  }

  const interval = Number(job.incremental_interval_minutes)
  if (Number.isFinite(interval) && interval > 0) {
    const last = job.last_incremental_run_at ? new Date(job.last_incremental_run_at).getTime() : 0
    const dueAt = last + interval * 60 * 1000
    if (nowDate.getTime() >= dueAt) return { skipped: false, mode: 'incremental' }
    return { skipped: true, reason: `not due — next incremental run at ${new Date(dueAt).toISOString()}` }
  }
  return { skipped: true, reason: 'not due — incremental runs are off (interval is 0) and no full run is due' }
}

/**
 * @param {object} [options.only]  a TEST run: { ruleIds, maxPersons }. Only persons that one of these rules matches are
 *   handled, at most maxPersons are written, and no state is saved in the job entry (a test can neither start, delay
 *   nor shorten the real import). Everything else (users, roles, editions, photos, emails, builds) is the real thing.
 */
export async function runSync ({ dryRun = false, force = false, mode = 'full', backlog = false, only = null } = {}, deps) {
  if (only && !(Array.isArray(only.ruleIds) && only.ruleIds.length)) throw new Error('a test run needs at least one rule id')
  const { fiona, strapi, config = {} } = deps
  const log = deps.log || console
  const now = deps.now || (() => new Date())
  const maxRemovals = Number.isFinite(Number(config.maxRemovals)) && config.maxRemovals !== undefined ? Number(config.maxRemovals) : 50
  const maxBuildsPerRun = Number.isFinite(Number(config.maxBuildsPerRun)) && config.maxBuildsPerRun !== undefined ? Number(config.maxBuildsPerRun) : 20
  // at most this many persons are written per run (0 = no cap); the run then stops and says more work remains
  let maxPersonsPerRun = Number.isFinite(Number(config.maxPersonsPerRun)) && config.maxPersonsPerRun !== undefined ? Number(config.maxPersonsPerRun) : 50
  const testRuleIds = only ? new Set(only.ruleIds.map(Number)) : null
  if (only && Number(only.maxPersons) > 0) maxPersonsPerRun = Number(only.maxPersons)
  let backlogRun = Boolean(backlog)
  // Strapi person ids whose existing biography the sync never overwrites (an empty one is still filled)
  const keepBioPersonIds = new Set(splitIds(config.keepBioPersonIds).map(Number))
  const startedAt = now()
  const startedMs = Date.now()
  const stats = newStats(dryRun, mode)
  deps.onStart?.(stats) // lets a caller watch the stats of a long run while it is still going
  stats.switches = { unpublishedPhotos: Boolean(config.unpublishedPhotos), unpublishedBios: Boolean(config.unpublishedBios) }
  stats.backlog = { cap: maxPersonsPerRun, more: false }
  if (only) stats.test = { ruleIds: [...testRuleIds], maxPersons: maxPersonsPerRun, outsideRules: 0 }
  const would = dryRun ? 'DRY RUN would ' : ''

  const warn = (message) => { stats.warnings.push(message); log.warn(message) }
  const recordDryRun = (entry) => { if (stats.dryRunActions.length < 500) stats.dryRunActions.push(entry) }
  const fail = (message, err) => {
    stats.errors++
    const line = `${message}: ${describeError(err)}`
    if (stats.errorMessages.length < 50) stats.errorMessages.push(line)
    log.error(line)
  }

  fiona.resetCache?.()

  // 0. Job entry + mode ------------------------------------------------------
  let job = null
  let jobDuplicates = []
  try {
    if (typeof strapi.getSyncJobs === 'function') {
      const jobs = await strapi.getSyncJobs(JOB_KEY)
      job = jobs[0] || null
      jobDuplicates = jobs.slice(1).map(entry => entry.id)
    } else if (typeof strapi.getSyncJob === 'function') {
      job = await strapi.getSyncJob(JOB_KEY)
    }
  } catch (err) {
    fail('could not read the fiona-sync-job entry', err)
  }
  stats.job = job
    ? {
        id: job.id,
        name: job.name ?? null,
        enabled: job.enabled,
        incrementalIntervalMinutes: job.incremental_interval_minutes ?? null,
        fullRunHour: job.full_run_hour ?? null,
        lastFullRunAt: job.last_full_run_at ?? null,
        lastIncrementalRunAt: job.last_incremental_run_at ?? null,
        duplicates: jobDuplicates
      }
    : null
  const duplicateMessage = jobDuplicates.length
    ? `${jobDuplicates.length + 1} fiona-sync-job entries share the key "${JOB_KEY}" (#${[job.id, ...jobDuplicates].join(', #')}): which one counts is not defined, delete the ones you do not want`
    : null
  if (duplicateMessage) warn(duplicateMessage)
  if (mode === 'auto' && duplicateMessage) {
    // never let a second entry start a run nobody expects: the automatic mode stays off until only one is left
    stats.skipped = true
    stats.reason = `${duplicateMessage} — the automatic mode is off until only one is left`
    stats.durationSec = Number(((Date.now() - startedMs) / 1000).toFixed(1))
    return stats
  }
  if (mode === 'auto') {
    const decision = decideAutoMode(job, startedAt)
    if (decision.skipped) {
      stats.skipped = true
      stats.reason = decision.reason
      if (!job) warn(decision.reason)
      else log.info(`auto: ${decision.reason}`)
      stats.durationSec = Number(((Date.now() - startedMs) / 1000).toFixed(1))
      return stats
    }
    mode = decision.mode
    backlogRun = Boolean(decision.backlog)
  }
  if (mode === 'incremental' && !job?.mutation_cursor) {
    warn('no mutation cursor yet — running a full sync first')
    mode = 'full'
  }
  stats.mode = mode

  let scanCompleted = false
  let buildQueue = null // the waiting list to save with the job entry; null = leave it as it is

  const finish = async ({ save = true } = {}) => {
    stats.durationSec = Number(((Date.now() - startedMs) / 1000).toFixed(1))
    if (save && !dryRun && !only && job && typeof strapi.saveSyncJob === 'function') {
      const patch = {
        last_stats: stats,
        last_error: stats.errorMessages[0] || null,
        [mode === 'full' ? 'last_full_run_at' : 'last_incremental_run_at']: startedAt.toISOString()
      }
      if (scanCompleted) patch.mutation_cursor = startedAt.toISOString()
      if (buildQueue !== null) patch.build_queue = buildQueue
      try {
        await strapi.saveSyncJob(job.id, patch)
      } catch (err) {
        fail('could not save the fiona-sync-job entry', err)
      }
    }
    log.info(`✅ Done (${mode}) in ${stats.durationSec}s — ${JSON.stringify({ ...stats, warnings: stats.warnings.length, guestbookBadges: undefined, badgeStatuses: undefined })}`)
    return stats
  }

  log.info(`▶ Starting Fiona sync (${mode}${dryRun ? ', DRY RUN' : ''}) at ${startedAt.toISOString()}`)

  // 1. Rules -----------------------------------------------------------------
  const rawRules = await strapi.loadRules()
  const { rules, warnings } = normalizeRules(rawRules)
  warnings.forEach(warn)
  reportRoleValidity(rawRules, startedAt, stats, warn)
  stats.rules.active = rules.length
  const discoveryOnly = rules.length === 0
  if (discoveryOnly) {
    warn('no active fiona-sync-rules — nothing to sync, removal phase skipped')
    stats.removals = { skipped: true, reason: 'no active rules' }
    if (!dryRun || mode !== 'full') return await finish()
    log.info('DRY RUN with no rules: scanning the active guestbooks for badge discovery only')
  }
  const index = indexRules(rules)

  // 2. Active guestbooks + their badge lists ---------------------------------
  const guestbookIds = await strapi.getActiveGuestbookIds()
  stats.guestbooks.active = guestbookIds.length
  if (!guestbookIds.length) await explainInactiveEditions()
  const activeGuestbooks = new Set(guestbookIds)

  const badgeLists = new Map() // guestbookId → [{id, name}] for guestbooks whose badge list loaded
  for (const guestbookId of guestbookIds) {
    try {
      badgeLists.set(guestbookId, await fiona.listGuestbookBadges(guestbookId))
    } catch (err) {
      fail(`guestbook ${guestbookId} badge list could not be fetched — its persons are left untouched`, err)
    }
  }

  const badgeIdsInScanned = new Set()
  const badgeNamesInScanned = new Set()
  const badgeNameById = new Map()
  for (const [guestbookId, badges] of badgeLists) {
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
    const line = `rule #${rule.id} "${rule.name}" badge ${rule.badgeId || rule.badgeName} sync=[${[...rule.level1].join(', ')}] full=[${[...rule.level2].join(', ')}] editions=[${rule.editionIds.join(', ')}] roles=[${rule.roleIds.join(', ')}]`
    if (mappedRules.includes(rule)) log.info(line)
    else warn(`${line} — matches no badge in the active guestbooks`)
  }
  const editionIdsInScope = new Set(mappedRules.flatMap(rule => rule.editionIds))
  const roleIdsInScope = new Set(mappedRules.flatMap(rule => rule.roleIds))

  // 3. Snapshot of the persons the sync manages ------------------------------
  const managedPeople = await strapi.findManagedPeople()
  const managedByFionaId = new Map(managedPeople.map(person => [person.fiona_person_id, person]))
  const managedByAccreditationId = new Map()
  for (const person of managedPeople) {
    for (const id of splitIds(person.fiona_accreditation_id)) managedByAccreditationId.set(id, person)
  }

  // 4. Desired state ---------------------------------------------------------
  const desired = new Map()
  const privacy = new Map() // fionaPersonId → { contact, email, phone }, true when ANY of the person's accreditations says so
  const erroredAccreditationIds = new Set()
  const erroredPersonIds = new Set()
  const histogram = new Map() // guestbookId → Map(label → { badgeName, badgeId, counts })

  // Which custom field keys the matched accreditations carry (and in how many the box is ticked):
  // makes a wrong or missing privacy-flag key visible in a dry run.
  const countCustomFields = (customFields) => {
    for (const field of Array.isArray(customFields) ? customFields : []) {
      const entry = stats.customFieldKeys[field.key] || (Object.keys(stats.customFieldKeys).length < 80 ? (stats.customFieldKeys[field.key] = { accreditations: 0, ticked: 0 }) : null)
      if (!entry) continue
      entry.accreditations++
      if (field.value === true || field.value === 1 || ['true', 'yes', 'on', '1'].includes(String(field.value).trim().toLowerCase())) entry.ticked++
    }
  }

  const countBadges = (guestbookId, badges) => {
    if (!histogram.has(guestbookId)) histogram.set(guestbookId, new Map())
    const seenHere = histogram.get(guestbookId)
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
  }

  /** Evaluate one accreditation into `desired`. Returns true when it matched a rule. */
  const evaluateAccreditationInto = async (guestbookId, accreditationId) => {
    const badges = await fiona.getAccreditationBadges(accreditationId)
    countBadges(guestbookId, badges)
    const evaluation = evaluateBadges(badges, index)
    if (evaluation.level === 0) return false
    const detail = await fiona.getAccreditation(accreditationId)
    if (!detail.personId) {
      warn(`accreditation ${accreditationId} has no linked person — skipped`)
      return false
    }
    mergeDesired(desired, detail.personId, { guestbookId, accreditationId, evaluation })
    const before = privacy.get(detail.personId) || { contact: false, email: false, phone: false }
    privacy.set(detail.personId, {
      contact: before.contact || detail.noPublicationOfContactDetails === true,
      email: before.email || detail.noPublicationOfEmail === true,
      phone: before.phone || detail.noPublicationOfPhone === true
    })
    countCustomFields(detail.customFields)
    return true
  }

  const logHistogram = (guestbookId) => {
    for (const { badgeName, badgeId, counts } of (histogram.get(guestbookId) || new Map()).values()) {
      const summary = [...counts]
        .sort((a, b) => b[1] - a[1] || (a[0] > b[0] ? 1 : -1))
        .map(([status, n]) => `${status}=${n}`)
        .join(', ')
      log.info(`Guestbook ${guestbookId} badge "${badgeName}" (${badgeId}) statuses: ${summary}`)
    }
  }

  let scannedGuestbookIds
  let reconcileManaged = managedPeople

  if (mode === 'full') {
    scannedGuestbookIds = new Set()
    for (const guestbookId of guestbookIds) {
      if (!badgeLists.has(guestbookId)) continue
      let accreditations
      try {
        accreditations = await fiona.listAccreditations(guestbookId)
      } catch (err) {
        fail(`guestbook ${guestbookId} could not be fetched — its persons are left untouched`, err)
        continue
      }
      scannedGuestbookIds.add(guestbookId)
      stats.accreditations.seen += accreditations.length
      let matched = 0
      for (const accreditation of accreditations) {
        try {
          if (await evaluateAccreditationInto(guestbookId, accreditation.id)) matched++
        } catch (err) {
          stats.accreditations.errors++
          erroredAccreditationIds.add(String(accreditation.id))
          fail(`accreditation ${accreditation.id}`, err)
        }
      }
      stats.accreditations.matched += matched
      log.info(`Guestbook ${guestbookId}: ${accreditations.length} accreditations, ${matched} matched`)
      logHistogram(guestbookId)
    }
    stats.guestbooks.scanned = scannedGuestbookIds.size
    stats.guestbooks.failed = guestbookIds.length - scannedGuestbookIds.size
    if (stats.guestbooks.failed) await explainFailedGuestbooks(guestbookIds.filter(id => !scannedGuestbookIds.has(id)))
    scanCompleted = stats.guestbooks.failed === 0
  } else {
    // incremental: which accreditations / persons changed since the cursor?
    const since = new Date(new Date(job.mutation_cursor).getTime() - MUTATION_OVERLAP_MS).toISOString()
    let mutations
    try {
      mutations = await fiona.listMutations(since)
    } catch (err) {
      fail(`mutations since ${since} could not be fetched`, err)
      return await finish()
    }
    const relevant = mutations.filter(m => RELEVANT_ENTITIES.has(m.entityName))
    const affectedAccreditationIds = new Set()
    const affectedPersonIds = new Set()
    let unresolvedBadges = 0

    for (const m of relevant) {
      if (m.entityName === 'Accreditation') {
        if (m.mutation === 2) {
          const owner = managedByAccreditationId.get(String(m.entityId))
          if (owner) affectedPersonIds.add(owner.fiona_person_id)
        } else {
          affectedAccreditationIds.add(String(m.entityId))
        }
      } else if (m.entityName === 'AccreditationBadge') {
        try {
          const { accreditationId } = await fiona.getAccreditationBadgeRecord(m.entityId)
          if (accreditationId) affectedAccreditationIds.add(String(accreditationId))
          else unresolvedBadges++
        } catch (err) {
          unresolvedBadges++
          if (!isNotFound(err)) fail(`accreditation badge ${m.entityId}`, err)
        }
      } else if (m.entityName === 'Person') {
        if (managedByFionaId.has(String(m.entityId))) affectedPersonIds.add(String(m.entityId))
      }
    }

    for (const accreditationId of affectedAccreditationIds) {
      try {
        const detail = await fiona.getAccreditation(accreditationId)
        if (detail.personId && activeGuestbooks.has(detail.guestbookId)) affectedPersonIds.add(String(detail.personId))
      } catch (err) {
        const owner = managedByAccreditationId.get(accreditationId)
        if (isNotFound(err) && owner) {
          affectedPersonIds.add(owner.fiona_person_id)
        } else if (!isNotFound(err)) {
          stats.accreditations.errors++
          erroredAccreditationIds.add(accreditationId)
          fail(`accreditation ${accreditationId}`, err)
        }
      }
    }

    for (const personId of affectedPersonIds) {
      let accreditations = []
      try {
        accreditations = await fiona.getPersonAccreditations(personId)
      } catch (err) {
        if (!isNotFound(err)) {
          erroredPersonIds.add(personId)
          fail(`person ${personId} accreditations`, err)
          continue
        }
      }
      for (const accreditation of accreditations.filter(a => activeGuestbooks.has(a.guestbookId))) {
        stats.accreditations.seen++
        try {
          if (await evaluateAccreditationInto(accreditation.guestbookId, accreditation.id)) stats.accreditations.matched++
        } catch (err) {
          stats.accreditations.errors++
          erroredAccreditationIds.add(String(accreditation.id))
          erroredPersonIds.add(personId)
          fail(`accreditation ${accreditation.id}`, err)
        }
      }
    }
    if (unresolvedBadges) warn(`${unresolvedBadges} accreditation-badge mutation(s) could not be resolved to an accreditation — the nightly full run reconciles them`)

    scannedGuestbookIds = new Set(badgeLists.keys())
    stats.guestbooks.scanned = scannedGuestbookIds.size
    stats.guestbooks.failed = guestbookIds.length - scannedGuestbookIds.size
    reconcileManaged = managedPeople.filter(person => affectedPersonIds.has(person.fiona_person_id))
    stats.incremental = {
      since,
      mutations: mutations.length,
      relevant: relevant.length,
      accreditations: affectedAccreditationIds.size,
      persons: affectedPersonIds.size,
      unresolvedBadges
    }
    scanCompleted = true
    log.info(`Incremental: ${mutations.length} mutations since ${since}, ${relevant.length} relevant, ${affectedAccreditationIds.size} accreditations and ${affectedPersonIds.size} persons re-evaluated`)
  }
  stats.persons.desired = desired.size
  if (discoveryOnly) return await finish()

  // 5. Plan removals (from the snapshot taken before any write) ----------------
  for (const person of managedPeople) {
    if (splitIds(person.fiona_accreditation_id).some(id => erroredAccreditationIds.has(id))) erroredPersonIds.add(person.fiona_person_id)
  }
  const plan = planRemovals({
    managedPeople: reconcileManaged,
    desired,
    scannedGuestbookIds,
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

  // Site builds: only persons changed by a rule with "target builds" are candidates; persons the sync takes off
  // Creative Gate are listed in removedIds and never built here.
  const buildRules = new Map(rules.filter(rule => rule.targetBuilds).map(rule => [rule.id, rule]))
  const buildCandidates = []
  const removedIds = []

  // per rule: how many persons it matches and how many of them get the full profile (what a run would do, before it does it)
  stats.rules.detail = rules.map(rule => ({
    id: rule.id,
    name: rule.name,
    targetBuilds: Boolean(rule.targetBuilds),
    persons: [...desired.values()].filter(entry => entry.matchedRuleIds.has(rule.id)).length,
    fullProfile: [...desired.values()].filter(entry => entry.fullRuleIds.has(rule.id)).length
  }))

  // 6. Upsert desired persons -----------------------------------------------
  if (testRuleIds) stats.test.outsideRules = [...desired.values()].filter(entry => ![...entry.matchedRuleIds].some(id => testRuleIds.has(Number(id)))).length
  let written = 0 // persons this run writes: created, or updated because something differs
  for (const [fionaPersonId, want] of desired) {
    if (erroredPersonIds.has(fionaPersonId)) continue
    // a test run handles only the persons the chosen rules match
    if (testRuleIds && ![...want.matchedRuleIds].some(id => testRuleIds.has(Number(id)))) continue
    // the cap of persons written per run is reached: stop here and say so; the next run carries on (see decideAutoMode)
    if (!dryRun && maxPersonsPerRun > 0 && written >= maxPersonsPerRun) {
      stats.backlog.more = true
      break
    }
    // a backlog run leaves alone the persons the run before wrote, without a single call to Fiona or Strapi
    if (backlogRun && !dryRun) {
      const managed = managedByFionaId.get(fionaPersonId)
      if (managed?.fiona_synced_at && startedAt.getTime() - new Date(managed.fiona_synced_at).getTime() < BACKLOG_RECENT_HOURS * 3600 * 1000) continue
    }
    try {
      const fionaPerson = await fiona.getPerson(fionaPersonId, { accreditationIds: [...want.accreditationIds], level: want.level })
      if (want.level === 2) {
        if (fionaPerson.bio) stats.bios.accreditation++
        else if (stats.bios.missing.length < 100) stats.bios.missing.push([fionaPerson.firstName, fionaPerson.lastName].filter(Boolean).join(' '))
      }

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
      if (user) {
        if (user.confirmed === false) stats.users.unconfirmedSeen++
        else if (user.confirmed === undefined) stats.users.confirmedFieldMissing++
      }

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

      const hide = privacy.get(fionaPersonId) || { contact: false, email: false, phone: false }
      const payload = buildPersonPayload({
        fionaPerson,
        level: want.level,
        contactEmail,
        noPublicationOfContactDetails: hide.contact,
        noPublicationOfEmail: hide.email,
        noPublicationOfPhone: hide.phone
      })
      if (existing && existing.bio_en && keepBioPersonIds.has(Number(existing.id))) delete payload.bio_en
      // a biography from the accreditation card only fills an empty one; it never replaces a text that is already there
      if (existing && existing.bio_en && fionaPerson.bioSource === 'accreditation') delete payload.bio_en
      const withheld = []
      if (hide.contact || hide.email) withheld.push('email')
      if (fionaPerson.phone && (hide.contact || hide.phone)) withheld.push('phone')
      if (withheld.includes('email')) stats.privacy.emailWithheld++
      if (withheld.includes('phone')) stats.privacy.phoneWithheld++
      // a box ticked after the value was written: take the stored value off the person again
      const clear = valuesToClear({
        existing,
        fionaPerson,
        contactEmail,
        withholdEmail: hide.contact || hide.email,
        withholdPhone: hide.contact || hide.phone
      })
      Object.assign(payload, clear)
      const cleared = []
      if ('eMail' in clear) cleared.push('email')
      if ('phoneNr' in clear) cleared.push('phone')
      if (cleared.includes('email')) stats.privacy.emailCleared++
      if (cleared.includes('phone')) stats.privacy.phoneCleared++
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
          photo = await fiona.getPersonPhoto(fionaPersonId, { accreditationIds: [...want.accreditationIds], level: want.level, download: !dryRun })
        } catch (err) {
          warn(`person ${fionaPersonId}: photo unavailable (${err.message})`)
        }
        if (photo) stats.photos[photo.source === 'headshot' ? 'headshot' : 'published']++
        else if (want.level === 2 && stats.photos.missing.length < 100) stats.photos.missing.push([fionaPerson.firstName, fionaPerson.lastName].filter(Boolean).join(' '))
      }

      const changed = existing ? changedFields(existing, payload) : null
      // the picture joins the payload only after the upload (real runs), so a photo that is the only difference would
      // look like "nothing changed" and never be written: count it as a change of the person here
      if (photo && existing && !changed.includes('picture')) changed.push('picture')
      if (!dryRun && (!existing || changed.length > 0)) written++
      const summary = `person ${fionaPersonId} ${fionaPerson.firstName} ${fionaPerson.lastName} level ${want.level} editions=[${editionIds.join(', ')}] roles=[${[...want.roleIds].join(', ')}]`

      if (dryRun) {
        const name = [fionaPerson.firstName, fionaPerson.lastName].filter(Boolean).join(' ')
        const plan = { fionaPersonId, name, level: want.level, editionIds: uniqueNumbers(want.editionIds), roleIds: uniqueNumbers(want.roleIds), ...(withheld.length ? { withheld } : {}), ...(cleared.length ? { cleared } : {}), ...(photo?.source ? { photo: photo.source } : {}), ...(want.level === 2 && fionaPerson.bio ? { bio: 'accreditation', bioChars: String(fionaPerson.bio).length } : {}), ...(photo?.choice === 'default' || photo?.choice === 'latest' ? { photoChoice: photo.choice } : {}) }
        if (!existing) {
          stats.persons.created++
          log.info(`${would}CREATE ${summary}`)
          recordDryRun({ action: 'CREATE', ...plan, changed: null })
        } else if (changed.length) {
          stats.persons.updated++
          log.info(`${would}UPDATE person #${existing.id} (${changed.join(', ')}) ${summary}`)
          const diff = contentDiff(existing, payload, changed)
          const compare = Object.keys(diff).length ? { diff, strapiUpdatedAt: existing.updated_at || null } : {}
          recordDryRun({ action: 'UPDATE', personId: existing.id, ...plan, changed, ...compare })
        } else {
          stats.persons.unchanged++
        }
        if (action) {
          log.info(`${would}${action.type} person #${existing?.id} -editions=[${detach.join(', ')}] -roles=[${removeRoles.join(', ')}]`)
          recordDryRun({ action: action.type, fionaPersonId, personId: existing?.id, detachEditionIds: detach, removeRoleIds: removeRoles })
        }
        stats.editions.attached += newlyAttached.length
        stats.editions.detached += detach.length
        if (want.level === 2 && (!existing || changed.length) && [...want.fullRuleIds].some(id => buildRules.has(id))) stats.build.candidates++
        continue
      }

      if (photo) {
        // the photo is named R_Firstname_Lastname.jpg (Strapi makes the square sizes from the R_ prefix and the media
        // library finds it by the name of the person). A photo of an earlier run that was uploaded under the old name
        // fiona-person-<id>.jpg but never attached is replaced in place under the new name, not uploaded a second time.
        const fileName = headshotFileName(fionaPerson.firstName, fionaPerson.lastName, `fiona-${fionaPersonId}`)
        const unusedId = await strapi.findOrphanPhoto?.(photo.filename)
        let fileId = unusedId ? await strapi.uploadPhoto(photo.buffer, fileName, { replaceId: unusedId }) : null
        if (!fileId) fileId = unusedId || await strapi.uploadPhoto(photo.buffer, fileName)
        if (fileId) payload.picture = fileId
      }

      // The login user comes first: find or register, confirm, user profile and publisher roles. Strapi sends the
      // Creative Gate "created" email on the save that makes the person ready (CG edition and a linked user), and
      // only when the user already holds a publisher role at that moment, so the roles must be in place before the
      // person is written and linked. The link is the very last step.
      if (!user) {
        const result = await strapi.findOrRegisterUser(contactEmail)
        user = result.user
        if (result.created) stats.users.created++
      }
      if (user.confirmed === false && typeof strapi.confirmUser === 'function') {
        await strapi.confirmUser(user.id) // identity comes from Fiona; also unblocks Strapi's own confirmation gate
        stats.users.confirmed++
      }
      const profile = await strapi.ensureUserProfile(user, {
        email: contactEmail,
        firstName: fionaPerson.firstName || null,
        lastName: fionaPerson.lastName || null,
        ...(fionaPerson.phone ? { phoneNr: fionaPerson.phone } : {})
      })
      if (profile === true || profile?.created) stats.profiles.created++
      else if (profile?.updated?.length) stats.profiles.updated++

      if (want.roleIds.size || removeRoles.length) {
        const currentRoles = await strapi.getUserRoleIds(user.id)
        const nextRoles = uniqueNumbers([...currentRoles.filter(id => !removeRoles.includes(Number(id))), ...want.roleIds])
        if (!sameIds(currentRoles, nextRoles)) await strapi.setUserRoles(user.id, nextRoles)
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

      if (Number(relationId(user.person)) !== Number(person.id)) {
        await strapi.linkPersonToUser(person.id, user.id)
        stats.users.linked++
      }

      if (detach.length) removedIds.push(Number(person.id))
      if (want.level === 2 && personChanged) {
        const ruleIds = [...want.fullRuleIds].filter(id => buildRules.has(id))
        if (ruleIds.length) buildCandidates.push({ personId: Number(person.id), ruleIds })
      }
    } catch (err) {
      fail(`person ${fionaPersonId}`, err)
    }
  }

  // a dry run ignores the cap and says how many runs the import would need
  if (dryRun && maxPersonsPerRun > 0) {
    const planned = stats.persons.created + stats.persons.updated
    stats.backlog = { cap: maxPersonsPerRun, more: false, planned, runsNeeded: Math.ceil(planned / maxPersonsPerRun) }
  }

  // 7. Remaining removals (persons no longer desired) ------------------------
  for (const action of plan.actions) {
    if (desired.has(action.fionaPersonId)) continue
    const person = managedByFionaId.get(action.fionaPersonId)
    if (!person) continue
    try {
      const label = `${action.type} person #${person.id} (${action.fionaPersonId}) -editions=[${action.detachEditionIds.join(', ')}] -roles=[${action.removeRoleIds.join(', ')}]`
      if (action.type === 'UNPUBLISH') stats.persons.unpublished++
      else stats.persons.downgraded++
      stats.editions.detached += action.detachEditionIds.length
      if (dryRun) {
        log.info(`${would}${label}`)
        recordDryRun({ action: action.type, fionaPersonId: action.fionaPersonId, personId: person.id, detachEditionIds: action.detachEditionIds, removeRoleIds: action.removeRoleIds })
        continue
      }

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
      removedIds.push(Number(person.id))
      log.info(label)
    } catch (err) {
      fail(`removal for person #${person.id}`, err)
    }
  }

  // 8. Builds ----------------------------------------------------------------
  // Each rule builds at most its limit of changed persons per run (empty limit = the global default); the rest wait
  // in the job's build_queue for the next runs. Persons the sync takes off Creative Gate are never built here: they
  // leave the site at the next manual full build, so a mistake in Fiona or in the automation cannot take pages away.
  stats.build.removedWithoutBuild = uniqueNumbers(removedIds)
  if (stats.build.removedWithoutBuild.length) {
    warn(`${stats.build.removedWithoutBuild.length} persons were taken off Creative Gate — their pages stay on the site until your next full build + publish`)
  }
  const waitingBefore = normalizeBuildQueue(job?.build_queue)
  if (dryRun) {
    stats.build.queued = mergeBuildQueue(waitingBefore, [], buildRules).length
  } else {
    stats.build.candidates = buildCandidates.length
    const allowance = new Map([...buildRules].map(([id, rule]) => [id, rule.targetBuildsLimitPerRun ?? maxBuildsPerRun]))
    const waiting = []
    const built = []
    const removedThisRun = new Set(stats.build.removedWithoutBuild)
    for (const entry of mergeBuildQueue(waitingBefore, buildCandidates, buildRules)) {
      if (removedThisRun.has(entry.personId)) continue // taken off Creative Gate while waiting: never built here
      const ruleId = entry.ruleIds.find(id => allowance.get(id) > 0)
      if (ruleId === undefined) {
        waiting.push(entry)
        continue
      }
      allowance.set(ruleId, allowance.get(ruleId) - 1)
      try {
        await strapi.updatePerson(entry.personId, { fiona_synced_at: now().toISOString() }) // no skipbuild → per-person site build
        built.push(entry.personId)
      } catch (err) {
        fail(`build touch for person #${entry.personId}`, err)
      }
    }
    stats.build.ids = built
    stats.build.triggered = built.length > 0
    stats.build.queued = waiting.length
    // the waiting list lives in the job entry's build_queue field; an entry without that field (not created yet)
    // cannot keep it, and writing an unknown field must not break saving the rest of the job state
    if (job && 'build_queue' in job && typeof strapi.saveSyncJob === 'function') {
      buildQueue = waiting
      if (waiting.length) log.info(`${built.length} persons built now, ${waiting.length} wait for the next runs`)
    } else if (waiting.length) {
      warn(`${waiting.length} persons are not built yet and the fiona-sync-job entry has no build_queue field to keep them waiting — run a full build + publish from the Strapi admin`)
    }
  }

  return await finish()

  // ---------------------------------------------------------------------------

  /** A configured guestbook could not be fetched: is its id even known to Fiona? */
  async function explainFailedGuestbooks (failedIds) {
    let known
    try {
      known = await fiona.listGuestbooks()
    } catch (err) {
      warn(`could not list Fiona guestbooks: ${describeError(err)}`)
      return
    }
    stats.knownGuestbooks = known
    const knownList = known.map(guestbook => `${guestbook.name} (${guestbook.id})`).join(', ') || '(none)'
    for (const id of failedIds) {
      const match = known.find(guestbook => norm(guestbook.id) === norm(id))
      if (match) warn(`guestbook ${id} is known to Fiona as "${match.name}" — the error is on Fiona's side, try again later or ask Fiona support`)
      else warn(`guestbook ${id} is NOT among the guestbooks Fiona knows for this API key: ${knownList} — check guestbook_id on the festival edition`)
    }
  }

  /** Why is no guestbook active? List every edition with a guestbook id and its window. */
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
}
