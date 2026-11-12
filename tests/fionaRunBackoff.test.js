/**
 * createRunBackoff — the cron calls the sync in "auto" mode every minute. When a run failed (on 2026-11-12 it ended after ten
 * minutes with a 504 from Strapi) nothing remembered that, so the next minute started the same heavy read again and kept
 * Strapi busy. After a failed run the cron now waits 15 minutes, then 30, then 60 (the cap), and starts again as soon as a run
 * succeeds.
 */
import { describe, it, expect } from 'vitest'
import { createRunBackoff } from '../server/utils/fiona/runBackoff.js'

const MINUTE = 60 * 1000
const START = Date.parse('2026-11-12T16:00:00Z')

function clock () {
  let t = START
  return { now: () => t, advance: (ms) => { t += ms } }
}

describe('createRunBackoff', () => {
  it('lets a run start when nothing has failed', () => {
    const { now } = clock()

    expect(createRunBackoff({ now }).check()).toBeNull()
  })

  it('holds the next run back for 15 minutes after a failure, and says until when', () => {
    const { now, advance } = clock()
    const backoff = createRunBackoff({ now })

    backoff.failed()

    expect(backoff.check()).toEqual({ failures: 1, retryAt: '2026-11-12T16:15:00.000Z', reason: 'backing off after 1 failed run - the next try is at 2026-11-12T16:15:00.000Z' })
    advance(14 * MINUTE + 59 * 1000)
    expect(backoff.check()).not.toBeNull()
    advance(1000)
    expect(backoff.check()).toBeNull()
  })

  it('waits longer after each failure in a row: 15, 30, then 60 minutes and no more', () => {
    const { now, advance } = clock()
    const backoff = createRunBackoff({ now })
    const waits = []

    for (let i = 0; i < 5; i++) {
      backoff.failed()
      const { retryAt } = backoff.check()
      waits.push((Date.parse(retryAt) - now()) / MINUTE)
      advance(Date.parse(retryAt) - now())
    }

    expect(waits).toEqual([15, 30, 60, 60, 60])
  })

  it('forgets the failures once a run succeeds', () => {
    const { now } = clock()
    const backoff = createRunBackoff({ now })

    backoff.failed()
    backoff.failed()
    backoff.succeeded()

    expect(backoff.check()).toBeNull()
    backoff.failed()
    expect(backoff.check().failures).toBe(1)
    expect(backoff.state()).toEqual({ failures: 1, retryAt: '2026-11-12T16:15:00.000Z' })
  })

  it('reports an idle state with no retry time', () => {
    expect(createRunBackoff({ now: clock().now }).state()).toEqual({ failures: 0, retryAt: null })
  })

  it('says "runs" in the plural for more than one failure', () => {
    const { now } = clock()
    const backoff = createRunBackoff({ now })

    backoff.failed()
    backoff.failed()

    expect(backoff.check().reason).toBe('backing off after 2 failed runs - the next try is at 2026-11-12T16:30:00.000Z')
  })
})
