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
 *                Add "probe": true (at most 10 persons) to also try the real Headshot download and Biography read
 *                and see whether each step worked (size, or the error message).
 *                A TEST run of the real thing: add "testRuleIds": [ruleId, ..] and "testMaxPersons": 10 to a full run. Only
 *                the persons those rules match are handled, at most that many are written, and nothing is saved in the
 *                job entry, so a test cannot start, delay or shorten the real import.
 *                Add "testScope": "new" to test only persons Strapi does not hold yet (the creation), or "existing" for
 *                only those it already holds (the adoption); the default is both.
 *                Any run can be started with "background": true: the answer comes at once and the run goes on.
 *                Ask { "mode": "status" } for the progress of the run that is going and the result of the last one
 *                (kept in memory only). Use it for anything that may last more than ten minutes: the platform cuts a
 *                request after about ten minutes while the run itself goes on.
 *                { "mode": "badges" } or { "mode": "badges", "guestbookIds": [..] } — read-only: the badge types of the
 *                active (or the given) guestbooks with their ids, straight from the XAPI (the id is what a rule's
 *                badge_type_id matches on).
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
  const mode = ['full', 'incremental', 'auto', 'compare', 'renotify', 'photos', 'badges', 'status'].includes(body?.mode) ? body.mode : 'full'
  // re-sending emails is the one thing that must never happen by accident: a dry run unless dryRun is explicitly false
  const dryRun = mode === 'renotify' ? body?.dryRun !== false : body?.dryRun === true
  const personIds = Array.isArray(body?.personIds) ? body.personIds : []
  const all = body?.all === true
  const guestbookIds = Array.isArray(body?.guestbookIds) ? body.guestbookIds : []
  const testRuleIds = Array.isArray(body?.testRuleIds) ? body.testRuleIds.map(Number).filter(Number.isFinite) : []
  const testMaxPersons = Number(body?.testMaxPersons) > 0 ? Number(body.testMaxPersons) : 0
  const testScope = ['new', 'existing'].includes(body?.testScope) ? body.testScope : 'all'
  const background = body?.background === true // start the run and answer at once; watch it with mode "status"
  const probe = body?.probe === true // photos mode: also try the Headshot download and the Biography read for at most 10 persons

  const stats = await runFionaSync({ dryRun, force, mode, personIds, all, probe, guestbookIds, background, testRuleIds, testMaxPersons, testScope })

  return { ok: true, stats }
})
