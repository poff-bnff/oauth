/**
 * Fallback manual-trigger endpoint for the Fiona sync.
 * Use this if Nitro scheduled tasks are not supported in the deployed environment,
 * OR to trigger a sync on demand from curl / a Strapi admin button.
 *
 * Auth: compare the Authorization header against NUXT_SYNC_SECRET from .env
 * Example:
 *   curl -X POST https://your-oauth-host/api/sync/fiona \
 *        -H "Authorization: Bearer <NUXT_SYNC_SECRET value>"
 *
 * Optional body: { "dryRun": true }  — logs intended changes without writing to Strapi.
 *                { "mode": "full" | "incremental" | "auto" | "compare" } — default "full"; "auto"
 *                lets the fiona-sync-job entry decide (what the cron sends every minute);
 *                "compare" is a read-only diagnostic listing the differences between the
 *                XAPI and the Publication API for the active guestbooks.
 *                { "force": true } — lift the per-run removal cap.
 *
 * One-off tools for persons the sync made (Strapi person ids, at most 100 per call):
 *                { "mode": "photos", "personIds": [..] or "all": true } — read-only: lists what Fiona holds as
 *                attachments (headshot, showcase, ...) for those persons, published or not. Never shows a file.
 *                { "mode": "renotify", "personIds": [..], "dryRun": false } — sends the Creative Gate "created"
 *                email of those persons once more (the edition is taken off and put back). A dry run unless
 *                "dryRun": false is given explicitly.
 */

import crypto from 'crypto'
import { runFionaSync } from '../../utils/fionaSync.js'

/**
 * Constant-time string comparison to prevent timing attacks on secret comparison.
 * Pads both buffers to the same length before calling timingSafeEqual.
 */
function timingSafeCompare (a, b) {
  const aBuf = Buffer.from(a, 'utf8')
  const bBuf = Buffer.from(b, 'utf8')
  // Use the longer length so neither value leaks its length via short-circuit
  const len = Math.max(aBuf.length, bBuf.length)
  const aPadded = Buffer.concat([aBuf, Buffer.alloc(len - aBuf.length)])
  const bPadded = Buffer.concat([bBuf, Buffer.alloc(len - bBuf.length)])
  return crypto.timingSafeEqual(aPadded, bPadded) && aBuf.length === bBuf.length
}

export default defineEventHandler(async (event) => {
  const config = useRuntimeConfig()

  // Guard: compare the bearer token against the shared secret from .env (NUXT_SYNC_SECRET).
  // This avoids any Strapi round-trip and keeps the endpoint independent of Strapi user tokens.
  const expectedSecret = config.syncSecret
  if (!expectedSecret) {
    throw createError({ statusCode: 500, statusMessage: 'NUXT_SYNC_SECRET is not configured' })
  }

  const authHeader = getRequestHeader(event, 'authorization') || ''
  const providedToken = authHeader.startsWith('Bearer ')
    ? authHeader.slice(7).trim()
    : ''

  if (!providedToken || !timingSafeCompare(providedToken, expectedSecret)) {
    throw createError({ statusCode: 401, statusMessage: 'Unauthorized' })
  }

  const body = await readBody(event).catch(() => ({}))
  const force = body?.force === true // lifts the per-run removal cap (NUXT_SYNC_MAX_REMOVALS)
  const mode = ['full', 'incremental', 'auto', 'compare', 'renotify', 'photos'].includes(body?.mode) ? body.mode : 'full'
  // re-sending emails is the one thing that must never happen by accident: a dry run unless dryRun is explicitly false
  const dryRun = mode === 'renotify' ? body?.dryRun !== false : body?.dryRun === true
  const personIds = Array.isArray(body?.personIds) ? body.personIds : []
  const all = body?.all === true

  const stats = await runFionaSync({ dryRun, force, mode, personIds, all })

  return { ok: true, stats }
})
