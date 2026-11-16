/**
 * attentionReport — read-only (mode `attention` of POST /api/sync/fiona): the persons somebody has to look at in Strapi, read from the
 * job entry's last_stats (saved by every real run, so the lists survive a restart of the app and are not lost when the next run starts).
 */
import { describe, it, expect } from 'vitest'
import { attentionReport } from '../server/utils/fiona/attentionReport.js'

const held = { fionaPersonId: 'fp2', name: 'Mari Maasikas', email: 'mari@example.com', reason: 'same name', candidates: [{ id: 21 }], seenAt: '2026-11-16T01:52:00.000Z' }
const conflict = { fionaPersonId: 'fp1', name: 'Edmond Yang', email: 'edmond@example.com', kind: 'email-owned-by-other-fiona-person', strapiPersonId: 20, otherFionaPersonId: 'fp-other', seenAt: '2026-11-16T01:52:00.000Z' }
const noEmail = { fionaPersonId: 'fp3', name: 'No Mail', seenAt: '2026-11-16T01:52:00.000Z' }

const strapiWith = job => ({ getSyncJob: key => Promise.resolve(job && job.key === key ? job : null) })
const job = (lastStats, extra = {}) => ({ id: 1, key: 'accreditations', last_full_run_at: '2026-11-16T01:52:01.821Z', last_incremental_run_at: '2026-11-16T18:33:01.000Z', last_stats: lastStats, ...extra })

describe('attentionReport', () => {
  it('hands over the three saved lists with their counts and when the job last ran', async () => {
    const report = await attentionReport({ strapi: strapiWith(job({ needsDecision: [held], conflictList: [conflict], noEmailList: [noEmail] })), jobKey: 'accreditations' })

    expect(report).toEqual({
      found: true,
      lastFullRunAt: '2026-11-16T01:52:01.821Z',
      lastIncrementalRunAt: '2026-11-16T18:33:01.000Z',
      counts: { needsDecision: 1, conflicts: 1, noEmail: 1 },
      needsDecision: [held],
      conflictList: [conflict],
      noEmailList: [noEmail]
    })
  })

  it('answers with empty lists for a job that has no saved stats yet', async () => {
    const report = await attentionReport({ strapi: strapiWith(job(null)), jobKey: 'accreditations' })

    expect(report.found).toBe(true)
    expect(report.counts).toEqual({ needsDecision: 0, conflicts: 0, noEmail: 0 })
    expect(report.conflictList).toEqual([])
  })

  it('says so when the job entry does not exist', async () => {
    const report = await attentionReport({ strapi: strapiWith(null), jobKey: 'accreditations' })

    expect(report).toEqual({ found: false, reason: 'no fiona-sync-job entry with key "accreditations"' })
  })

  it('ignores a list that is not a list', async () => {
    const report = await attentionReport({ strapi: strapiWith(job({ needsDecision: 'oops', conflictList: [conflict] })), jobKey: 'accreditations' })

    expect(report.needsDecision).toEqual([])
    expect(report.counts).toEqual({ needsDecision: 0, conflicts: 1, noEmail: 0 })
  })
})
