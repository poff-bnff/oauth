/**
 * fiona/attentionReport.js
 *
 * Read-only (mode `attention` of POST /api/sync/fiona): the persons somebody has to look at in Strapi, read from the job entry's
 * last_stats. Every real run saves its stats there and keeps the three lists between runs (sync.js, carryOverLists), so this answer
 * is the same whether the app has just restarted or a run has just ended. It lists personal data (names, e-mails): secret-protected.
 *
 *   needsDecision  held back: a same-name or same-e-mail person is in Strapi already (adopt it or create a new one)
 *   conflictList   skipped: the e-mail or the MyPoff login belongs to another person (merge or repair in Strapi)
 *   noEmailList    skipped: no e-mail in Fiona or at the login (fill it in in Fiona)
 */
const asList = value => (Array.isArray(value) ? value : [])

/**
 * @param {{ strapi: { getSyncJob: (key: string) => Promise<object|null> }, jobKey: string }} options
 */
export async function attentionReport ({ strapi, jobKey }) {
  const job = await strapi.getSyncJob(jobKey)
  if (!job) return { found: false, reason: `no fiona-sync-job entry with key "${jobKey}"` }
  const stats = job.last_stats && typeof job.last_stats === 'object' ? job.last_stats : {}
  const needsDecision = asList(stats.needsDecision)
  const conflictList = asList(stats.conflictList)
  const noEmailList = asList(stats.noEmailList)
  return {
    found: true,
    lastFullRunAt: job.last_full_run_at ?? null,
    lastIncrementalRunAt: job.last_incremental_run_at ?? null,
    counts: { needsDecision: needsDecision.length, conflicts: conflictList.length, noEmail: noEmailList.length },
    needsDecision,
    conflictList,
    noEmailList
  }
}
