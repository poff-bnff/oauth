/* eslint-disable no-console */
/**
 * fionaSync.js
 *
 * Fiona → Strapi accredited-person sync (POFF-166).
 *
 * This file only wires the Nuxt / Nitro environment ($fetch, runtime config,
 * strapi.js helpers) into the testable modules under ./fiona/:
 *   - fiona/rules.js         rule parsing + badge evaluation
 *   - fiona/desiredState.js  per-person desired state + removal planning
 *   - fiona/personMapper.js  Fiona person → Strapi person payload
 *   - fiona/xapiClient.js    Fiona XAPI access
 *   - fiona/strapiGateway.js Strapi REST access (admin token)
 *   - fiona/sync.js          the orchestrator
 *
 *   - fiona/publicationClient.js Publication API access (+ mutations feed)
 *   - fiona/hybridClient.js  Publication first, XAPI only as fallback
 *
 * Entry point: runFionaSync({ dryRun, force, mode }) — called by
 * server/api/sync/fiona.post.js (POST /api/sync/fiona, bearer NUXT_SYNC_SECRET).
 */

import { getStrapiAdminToken, getActiveFionaGuestbooks } from './strapi.js'
import { createXapiClient } from './fiona/xapiClient.js'
import { createPublicationClient } from './fiona/publicationClient.js'
import { createHybridClient } from './fiona/hybridClient.js'
import { createStrapiGateway } from './fiona/strapiGateway.js'
import { runSync } from './fiona/sync.js'
import { compareSources } from './fiona/compare.js'
import { renotifyPersons } from './fiona/renotify.js'
import { describePhotos } from './fiona/photoDiagnostic.js'
import { describeFionaFields } from './fiona/fieldDiagnostic.js'
import { listBadgeTypes } from './fiona/badgeTypes.js'

const config = useRuntimeConfig()

const log = {
  info: message => console.log('[fionaSync]', message),
  warn: message => console.warn('[fionaSync]', message),
  error: message => console.error('[fionaSync]', message)
}

let syncRunning = false
// What the app knows about its runs: the one that is going now (with its stats as they grow) and the last finished one.
// Kept in memory only; a long run is started with background: true and watched with mode "status", because a request
// that lasts more than about ten minutes is cut by the platform while the run itself goes on.
let currentRun = null
let lastRun = null

const slimStats = stats => (stats ? { ...stats, dryRunActions: undefined, guestbookBadges: undefined, badgeStatuses: undefined } : null)

function statusReport () {
  return {
    mode: 'status',
    running: Boolean(currentRun),
    current: currentRun ? { mode: currentRun.mode, dryRun: currentRun.dryRun, startedAt: currentRun.startedAt, stats: slimStats(currentRun.stats) } : null,
    last: lastRun
  }
}

function numberOr (value, fallback) {
  const parsed = Number(value)
  return value !== '' && value !== undefined && value !== null && Number.isFinite(parsed) ? parsed : fallback
}

function buildFionaClient () {
  const client = String(config.fionaClient || 'xapi').toLowerCase()
  const xapi = config.fionaApiKey ? createXapiClient({ fetch: $fetch, apiKey: config.fionaApiKey, log }) : null
  if (client === 'xapi') {
    if (!xapi) throw new Error('NUXT_FIONA_API_KEY is not configured')
    return xapi
  }
  if (client === 'publication') {
    if (!config.fionaPublicationApiKey) throw new Error('NUXT_FIONA_PUBLICATION_API_KEY is not configured')
    const publication = createPublicationClient({
      fetch: $fetch,
      apiKey: config.fionaPublicationApiKey,
      ...(config.fionaPublicationApiUrl ? { baseUrl: config.fionaPublicationApiUrl } : {}),
      log
    })
    return createHybridClient({
      publication,
      xapi,
      log,
      allowUnpublishedPhotos: String(config.syncUnpublishedPhotos).toLowerCase() === 'true',
      allowUnpublishedBios: String(config.syncUnpublishedBios).toLowerCase() === 'true'
    })
  }
  throw new Error(`NUXT_FIONA_CLIENT=${client} is not supported — use 'xapi' or 'publication'`)
}

function buildStrapiGateway () {
  return createStrapiGateway({
    fetch: $fetch,
    config,
    getAdminToken: getStrapiAdminToken,
    getActiveFionaGuestbooks,
    log
  })
}

function buildDeps () {
  const fiona = buildFionaClient()
  const strapi = buildStrapiGateway()
  return {
    fiona,
    strapi,
    log,
    onStart: (stats) => { if (currentRun) currentRun.stats = stats },
    config: {
      maxRemovals: numberOr(config.syncMaxRemovals, 50),
      maxBuildsPerRun: numberOr(config.syncMaxBuildsPerRun, 20),
      keepBioPersonIds: config.syncKeepBioPersonIds || '',
      maxPersonsPerRun: numberOr(config.syncMaxPersonsPerRun, 50),
      unpublishedPhotos: String(config.syncUnpublishedPhotos).toLowerCase() === 'true',
      unpublishedBios: String(config.syncUnpublishedBios).toLowerCase() === 'true'
    }
  }
}

/**
 * Run the sync. Returns the stats object (see fiona/sync.js).
 * @param {{ dryRun?: boolean, force?: boolean }} options
 */
/**
 * Diagnostic: read the active guestbooks through BOTH APIs and report the
 * differences (missing badge holders, status texts). Needs both keys. Read-only.
 */
async function compareFionaSources () {
  if (!config.fionaApiKey || !config.fionaPublicationApiKey) {
    throw new Error('compare needs both NUXT_FIONA_API_KEY and NUXT_FIONA_PUBLICATION_API_KEY')
  }
  const xapi = createXapiClient({ fetch: $fetch, apiKey: config.fionaApiKey, log })
  const publication = createPublicationClient({
    fetch: $fetch,
    apiKey: config.fionaPublicationApiKey,
    ...(config.fionaPublicationApiUrl ? { baseUrl: config.fionaPublicationApiUrl } : {}),
    log
  })
  const guestbookIds = await getActiveFionaGuestbooks()
  return { mode: 'compare', guestbookIds, ...(await compareSources({ xapi, publication, guestbookIds, log })) }
}

export async function runFionaSync ({ dryRun = false, force = false, mode = 'full', personIds = [], all = false, probe = false, guestbookIds = [], background = false, testRuleIds = [], testMaxPersons = 0, fieldPaths = [], testScope = 'all' } = {}) {
  if (mode === 'status') return statusReport()
  if (syncRunning) {
    log.warn('Sync already running — skipping this invocation')
    return { dryRun, mode, skipped: true, reason: 'already running' }
  }
  if (background) {
    // answer at once and let the run go on; its progress and result are asked for with mode "status"
    runTracked({ dryRun, force, mode, personIds, all, probe, guestbookIds, testRuleIds, testMaxPersons, testScope, fieldPaths }).catch(err => log.error(`background run failed: ${err?.message || err}`))
    return { started: true, mode, dryRun, hint: 'ask {"mode":"status"} for its progress and result' }
  }
  return await runTracked({ dryRun, force, mode, personIds, all, probe, guestbookIds, testRuleIds, testMaxPersons, testScope, fieldPaths })
}

async function runTracked ({ dryRun, force, mode, personIds, all, probe, guestbookIds, testRuleIds, testMaxPersons, testScope, fieldPaths }) {
  syncRunning = true
  currentRun = { mode, dryRun, startedAt: new Date().toISOString(), stats: null }
  try {
    const result = await runInner({ dryRun, force, mode, personIds, all, probe, guestbookIds, testRuleIds, testMaxPersons, testScope, fieldPaths })
    lastRun = { mode, dryRun, startedAt: currentRun.startedAt, finishedAt: new Date().toISOString(), stats: result }
    return result
  } catch (err) {
    lastRun = { mode, dryRun, startedAt: currentRun.startedAt, finishedAt: new Date().toISOString(), error: err?.message || String(err) }
    throw err
  } finally {
    currentRun = null
    syncRunning = false
  }
}

async function runInner ({ dryRun, force, mode, personIds, all, probe, guestbookIds, testRuleIds, testMaxPersons, testScope, fieldPaths }) {
  if (mode === 'compare') return await compareFionaSources()
  // One-off tools for persons the sync made (Strapi person ids): send the Creative Gate "created" email again,
  // and list what Fiona holds as photos (read-only, XAPI).
  if (mode === 'renotify') return { mode, ...(await renotifyPersons({ personIds, dryRun }, { strapi: buildStrapiGateway(), log })) }
  // read-only: the badge types of the active (or the given) guestbooks with their ids, from the XAPI
  if (mode === 'badges') {
    if (!config.fionaApiKey) throw new Error('badges needs NUXT_FIONA_API_KEY')
    const xapi = createXapiClient({ fetch: $fetch, apiKey: config.fionaApiKey, log })
    return { mode, ...(await listBadgeTypes({ guestbookIds, xapi, strapi: buildStrapiGateway(), log })) }
  }
  if (mode === 'photos') {
    if (!config.fionaApiKey) throw new Error('photos needs NUXT_FIONA_API_KEY')
    const xapi = createXapiClient({ fetch: $fetch, apiKey: config.fionaApiKey, log })
    return { mode, ...(await describePhotos({ personIds, all, probe, strapi: buildStrapiGateway(), xapi, log })) }
  }
  // read-only: the raw field structure of a few persons from both Fiona APIs (where is a value kept?)
  if (mode === 'fields') {
    if (!config.fionaPublicationApiKey) throw new Error('fields needs NUXT_FIONA_PUBLICATION_API_KEY')
    const publication = createPublicationClient({
      fetch: $fetch,
      apiKey: config.fionaPublicationApiKey,
      ...(config.fionaPublicationApiUrl ? { baseUrl: config.fionaPublicationApiUrl } : {}),
      log
    })
    const xapi = config.fionaApiKey ? createXapiClient({ fetch: $fetch, apiKey: config.fionaApiKey, log }) : null
    return { mode, ...(await describeFionaFields({ personIds, paths: fieldPaths, strapi: buildStrapiGateway(), publication, xapi, log })) }
  }
  const only = testRuleIds?.length ? { ruleIds: testRuleIds, maxPersons: testMaxPersons, scope: testScope } : null
  return await runSync({ dryRun, force, mode, only }, buildDeps())
}
