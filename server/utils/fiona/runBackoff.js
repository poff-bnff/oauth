/**
 * fiona/runBackoff.js
 *
 * The cron calls the sync in "auto" mode every minute. A run that failed (2026-11-12: after ten minutes with a 504 from
 * Strapi on GET /people?fiona_person_id_null=false&_limit=-1) left nothing behind that said so, so the next minute started the
 * same heavy read again and kept Strapi busy. After a failed run the next try waits 15 minutes, after the next failure in a
 * row 30, then 60 (the cap); a successful run resets it. Kept in memory: a restart of hunt starts afresh.
 */

const WAIT_MINUTES = [15, 30, 60]

export function createRunBackoff ({ now = Date.now } = {}) {
  let failures = 0
  let retryAt = 0

  return {
    /** null when a run may start; otherwise why it must wait and until when. */
    check () {
      if (!failures || now() >= retryAt) return null
      const at = new Date(retryAt).toISOString()
      return { failures, retryAt: at, reason: `backing off after ${failures} failed run${failures === 1 ? '' : 's'} - the next try is at ${at}` }
    },
    failed () {
      failures += 1
      retryAt = now() + WAIT_MINUTES[Math.min(failures, WAIT_MINUTES.length) - 1] * 60 * 1000
    },
    succeeded () {
      failures = 0
      retryAt = 0
    },
    state () {
      return { failures, retryAt: failures ? new Date(retryAt).toISOString() : null }
    }
  }
}
