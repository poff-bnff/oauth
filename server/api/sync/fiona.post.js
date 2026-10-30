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
 *                { "mode": "fields", "personIds": [..] } — read-only, at most 5 persons: where does Fiona keep a value? Lists
 *                every field path (with its type) of the person and of each accreditation, from the Publication API and
 *                the XAPI. Shows the values only of country / company / category / programme / occupation fields and of
 *                lookup keys; names, contact details and addresses are reported as "exists" only. Trip fields (arrival,
 *                departure, travel, flight) show their values too. Add "paths": ["xapi:/accreditation/{accreditationId}/x",
 *                "publication:/persons/{personId}/y"] (at most 10) to read further endpoints by name.
 *                { "mode": "twins", "background": true } — read-only: the persons the sync created that have a "twin", a person
 *                with the same name that the sync does not manage (duplicates). Every pair is put in tier A (obvious), B (look
 *                at it) or C (never automatic) with the reasons, and the places that use each person are listed. Takes a few
 *                minutes: ask {"mode":"status"} for the result (stats of the last run).
 *                { "mode": "merge", "pairs": [{ "keep": 20, "remove": 500 }, ..], "retire": "hide"|"delete", "dryRun": false } — merges
 *                persons that are one human (at most 100 pairs; ALWAYS a dry run unless dryRun is explicitly false). Everything of
 *                "remove" is moved onto "keep" (latest value wins for single values, lists are added together, Fiona ids, login
 *                user and address move), then "remove" is hidden ("hide": Fiona ids, e-mail and user taken off, not public) or
 *                deleted. A pair is skipped with a reason when it is not safe (names differ, "remove" is used in credits, passes
 *                or articles, two different login users, ...). Saves send no e-mail and start no build. Stops at the first error.
 *                The result carries a backup of both records of every merged pair. Use "background": true and read it with "status".
 *                Add "repointCredits": true to merge a "remove" that is credited in films, courses, industry or DISCamp projects,
 *                teams, filmographies, ...: those credits are pointed to "keep" first (a duplicate credit is dropped; the dry run lists
 *                every change, the backup holds the credit fields as they were). A festival pass or other use stays a reason to skip.
 *                A TEST run of the real thing: add "testRuleIds": [ruleId, ..] and "testMaxPersons": 10 to a full run. Only
 *                the persons those rules match are handled, at most that many are written, and nothing is saved in the
 *                job entry, so a test cannot start, delay or shorten the real import.
 *                Add "extraFields": true to a test run to let it write the extra values (country, companies, Programme/category,
 *                Current occupation) while the NUXT_SYNC_EXTRA_FIELDS switch is still off; a dry run always shows them.
 *                Add "testFionaPersonIds": ["<Fiona person id>", ..] to a test run to handle only those persons.
 *                Add "testScope": "new" to test only persons Strapi does not hold yet (the creation), or "existing" for
 *                only those it already holds (the adoption); the default is both.
 *                Any run can be started with "background": true: the answer comes at once and the run goes on.
 *                Ask { "mode": "status" } for the progress of the run that is going and the result of the last one
 *                (kept in memory only). Use it for anything that may last more than ten minutes: the platform cuts a
 *                request after about ten minutes while the run itself goes on.
 *                { "decisions": [{ "fionaPersonId": "<id>", "action": "adopt", "personId": 20 } | { "fionaPersonId": "<id>", "action": "create" }] }
 *                — what to do with Fiona persons the sync held back ("needsDecision" in the stats: a person with this name or
 *                e-mail may already be in Strapi). "adopt" gives the Fiona person to that Strapi person (the Fiona ids are
 *                written there), "create" makes a new person. Only those Fiona persons are handled, nothing is removed, no
 *                job state is saved. ALWAYS a dry run unless dryRun is explicitly false.
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
  const mode = ['full', 'incremental', 'auto', 'compare', 'renotify', 'photos', 'fields', 'twins', 'merge', 'badges', 'status'].includes(body?.mode) ? body.mode : 'full'
  // re-sending emails and merging persons must never happen by accident: a dry run unless dryRun is explicitly false
  // (so are decisions about Fiona persons the sync held back: they create or link persons)
  const sentDecisions = Array.isArray(body?.decisions) && body.decisions.length > 0
  const dryRun = ['renotify', 'merge'].includes(mode) || sentDecisions ? body?.dryRun !== false : body?.dryRun === true
  const personIds = Array.isArray(body?.personIds) ? body.personIds : []
  const all = body?.all === true
  const guestbookIds = Array.isArray(body?.guestbookIds) ? body.guestbookIds : []
  const testRuleIds = Array.isArray(body?.testRuleIds) ? body.testRuleIds.map(Number).filter(Number.isFinite) : []
  const testMaxPersons = Number(body?.testMaxPersons) > 0 ? Number(body.testMaxPersons) : 0
  const testScope = ['new', 'existing'].includes(body?.testScope) ? body.testScope : 'all'
  const background = body?.background === true // start the run and answer at once; watch it with mode "status"
  const fieldPaths = Array.isArray(body?.paths) ? body.paths.map(String) : [] // fields mode: extra endpoints to read, "xapi:/..." or "publication:/..."
  const testExtraFields = body?.extraFields === true // a test run only: write the extra values (country, companies, ...) even while the switch is off
  const testFionaPersonIds = Array.isArray(body?.testFionaPersonIds) ? body.testFionaPersonIds.map(String) : [] // a test run only: handle just these Fiona person ids
  const mergePairs = Array.isArray(body?.pairs) ? body.pairs.map(pair => ({ keep: Number(pair?.keep), remove: Number(pair?.remove) })) : [] // merge mode: [{ keep, remove }] Strapi person ids
  const mergeRetire = body?.retire === 'delete' ? 'delete' : 'hide' // merge mode: what happens to the record that is merged into the other
  const repointCredits = body?.repointCredits === true // merge mode: point the credits of the record to remove (films, courses, projects, teams, ...) to the record to keep first
  // decisions about Fiona persons the sync held back (they need a decision): [{ fionaPersonId, action: 'adopt', personId } | { fionaPersonId, action: 'create' }]
  const decisions = sentDecisions
    ? body.decisions.map(item => ({ fionaPersonId: String(item?.fionaPersonId ?? '').trim(), action: item?.action, personId: item?.personId == null ? null : Number(item.personId) }))
      .filter(item => item.fionaPersonId && (item.action === 'create' || (item.action === 'adopt' && Number.isInteger(item.personId) && item.personId > 0)))
    : []
  // a malformed list must never turn into an ordinary full run
  if (sentDecisions && decisions.length !== body.decisions.length) throw createError({ statusCode: 400, statusMessage: 'decisions must be [{ fionaPersonId, action: "adopt", personId } | { fionaPersonId, action: "create" }]' })
  const probe = body?.probe === true // photos mode: also try the Headshot download and the Biography read for at most 10 persons

  const stats = await runFionaSync({ dryRun, force, mode, personIds, all, probe, guestbookIds, background, testRuleIds, testMaxPersons, testScope, fieldPaths, testExtraFields, testFionaPersonIds, mergePairs, mergeRetire, repointCredits, decisions })

  return { ok: true, stats }
})
