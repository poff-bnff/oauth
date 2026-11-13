/**
 * createStepTimer / timing log — how long each step of a request took (user read, active guestbooks, the live Fiona read, ...),
 * for the Server-Timing header and for the read-only `timings` probe. Names and durations only: no names, e-mails or ids of
 * people other than the Strapi user id of the request.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { createStepTimer, noopTimer } from '../server/utils/fiona/stepTimer.js'
import { recordTiming, recentTimings, clearTimings } from '../server/utils/fiona/timingLog.js'

function clock () { let t = 1000; return { now: () => t, advance: (ms) => { t += ms } } }

describe('createStepTimer', () => {
  it('times each step and the whole, and returns what the step returned', async () => {
    const c = clock()
    const timer = createStepTimer({ now: c.now })

    const value = await timer.step('user', () => { c.advance(12); return Promise.resolve('u') })
    await timer.step('guestbooks', () => { c.advance(3.4); return Promise.resolve() })
    c.advance(5)

    expect(value).toBe('u')
    expect(timer.summary()).toEqual({ total: 20, steps: [{ name: 'user', ms: 12 }, { name: 'guestbooks', ms: 3 }] })
  })

  it('still records a step that fails, and passes the failure on', async () => {
    const c = clock()
    const timer = createStepTimer({ now: c.now })

    await expect(timer.step('live read', () => { c.advance(40); return Promise.reject(new Error('504')) })).rejects.toThrow('504')

    expect(timer.summary().steps).toEqual([{ name: 'live read', ms: 40, failed: true }])
  })

  it('writes a Server-Timing header value with token-safe names', async () => {
    const c = clock()
    const timer = createStepTimer({ now: c.now })
    await timer.step('live read (Fiona XAPI)', () => { c.advance(186); return Promise.resolve() })
    await timer.step('user', () => { c.advance(2); return Promise.resolve() })

    expect(timer.serverTiming()).toBe('live-read-Fiona-XAPI;dur=186, user;dur=2, total;dur=188')
  })

  it('keeps details noted during the request (such as the time of each Fiona call) next to the steps', () => {
    const c = clock()
    const timer = createStepTimer({ now: c.now })
    expect(timer.summary().details).toBeUndefined()

    timer.detail('liveCalls', [{ what: 'appointments', outcome: 'ok', ms: 180 }])

    expect(timer.summary().details).toEqual({ liveCalls: [{ what: 'appointments', outcome: 'ok', ms: 180 }] })
  })

  it('has a timer that does nothing, for callers that were not given one', async () => {
    expect(await noopTimer.step('x', () => Promise.resolve(7))).toBe(7)
    expect(() => noopTimer.detail('x', 1)).not.toThrow()
  })
})

describe('timing log', () => {
  beforeEach(() => clearTimings())

  it('keeps the most recent requests, newest first, and filters by user', () => {
    recordTiming({ kind: 'appointments', userId: 5, total: 10, steps: [] })
    recordTiming({ kind: 'login', userId: 6, total: 20, steps: [] })
    recordTiming({ kind: 'appointments', userId: 5, total: 30, steps: [] })

    expect(recentTimings().map(entry => entry.total)).toEqual([30, 20, 10])
    expect(recentTimings({ userIds: [5] }).map(entry => entry.total)).toEqual([30, 10])
    expect(recentTimings({ limit: 2 })).toHaveLength(2)
  })

  it('stamps each entry with the time and forgets the oldest beyond 100', () => {
    for (let i = 0; i < 105; i++) recordTiming({ kind: 'appointments', userId: 1, total: i, steps: [] })

    const all = recentTimings({ limit: 500 })
    expect(all).toHaveLength(100)
    expect(all[0].total).toBe(104)
    expect(all.at(-1).total).toBe(5)
    expect(new Date(all[0].at).toString()).not.toBe('Invalid Date')
  })
})
