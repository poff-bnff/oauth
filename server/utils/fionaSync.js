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

import { getStrapiAdminToken, authenticateStrapiUser, getActiveFionaGuestbooks } from './strapi.js'
import { createXapiClient } from './fiona/xapiClient.js'
import { createPublicationClient } from './fiona/publicationClient.js'
import { createHybridClient } from './fiona/hybridClient.js'
import { createStrapiGateway } from './fiona/strapiGateway.js'
import { runSync } from './fiona/sync.js'

const config = useRuntimeConfig()

const log = {
  info: message => console.log('[fionaSync]', message),
  warn: message => console.warn('[fionaSync]', message),
  error: message => console.error('[fionaSync]', message)
}

let syncRunning = false

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
    return createHybridClient({ publication, xapi, log })
  }
  throw new Error(`NUXT_FIONA_CLIENT=${client} is not supported — use 'xapi' or 'publication'`)
}

function buildDeps () {
  const fiona = buildFionaClient()
  const strapi = createStrapiGateway({
    fetch: $fetch,
    config,
    getAdminToken: getStrapiAdminToken,
    getActiveFionaGuestbooks,
    authenticateStrapiUser,
    log
  })
  return {
    fiona,
    strapi,
    log,
    config: {
      maxRemovals: numberOr(config.syncMaxRemovals, 50),
      maxBuildsPerRun: numberOr(config.syncMaxBuildsPerRun, 20)
    }
  }
}

/**
 * Run the sync. Returns the stats object (see fiona/sync.js).
 * @param {{ dryRun?: boolean, force?: boolean }} options
 */
export async function runFionaSync ({ dryRun = false, force = false, mode = 'full' } = {}) {
  if (syncRunning) {
    log.warn('Sync already running — skipping this invocation')
    return { dryRun, mode, skipped: true, reason: 'already running' }
  }
  syncRunning = true
  try {
    return await runSync({ dryRun, force, mode }, buildDeps())
  } finally {
    syncRunning = false
  }
}
