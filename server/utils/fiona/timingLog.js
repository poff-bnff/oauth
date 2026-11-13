/**
 * fiona/timingLog.js
 *
 * The last 100 timed requests (appointments, login) in memory, newest first, for the read-only `timings` probe mode of the sync
 * endpoint: { at, kind, userId, source, total, steps[{ name, ms, failed? }] }. No names, e-mails or other people's ids; lost on a restart.
 */
const MAX_ENTRIES = 100
const entries = []

export function recordTiming (entry) {
  entries.unshift({ at: new Date().toISOString(), ...entry })
  if (entries.length > MAX_ENTRIES) entries.length = MAX_ENTRIES
}

export function recentTimings ({ limit = 20, userIds } = {}) {
  const wanted = Array.isArray(userIds) && userIds.length ? new Set(userIds.map(String)) : null
  return entries.filter(entry => !wanted || wanted.has(String(entry.userId))).slice(0, limit)
}

export function clearTimings () {
  entries.length = 0
}
