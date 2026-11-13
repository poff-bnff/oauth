/**
 * Mode `timings` of the sync endpoint — read-only: the last timed requests (appointments, login) with the time of each step,
 * optionally only those of the given Strapi user ids. For load tests: watch what a real login and page load cost, step by step.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../server/utils/fiona/sync.js', () => ({ runSync: vi.fn() }))
vi.mock('../server/utils/strapi.js', () => ({
  getStrapiAdminToken: vi.fn(),
  getActiveFionaGuestbooks: vi.fn(),
  getStrapiUser: vi.fn(),
  getStrapiPerson: vi.fn(),
  fetchStrapiUserRolesGraphql: vi.fn(),
  fetchStrapiUserRolesRest: vi.fn()
}))

let runFionaSync
let recordTiming
let clearTimings

beforeEach(async () => {
  globalThis.useRuntimeConfig = () => ({ strapiUrl: 'http://localhost:1337', fionaApiKey: 'test-key' })
  vi.resetModules()
  ;({ recordTiming, clearTimings } = await import('../server/utils/fiona/timingLog.js'))
  clearTimings()
  ;({ runFionaSync } = await import('../server/utils/fionaSync.js'))
})

describe('runFionaSync mode "timings"', () => {
  it('answers the recent timed requests, newest first, without starting a sync run', async () => {
    recordTiming({ kind: 'login', userId: '22135', source: 'oauth', ok: true, total: 900, steps: [{ name: 'role sync (Fiona badges + Strapi)', ms: 700 }] })
    recordTiming({ kind: 'appointments', userId: 22135, source: 'live', ok: true, total: 250, steps: [{ name: 'live read (Fiona XAPI)', ms: 190 }] })

    const result = await runFionaSync({ mode: 'timings' })

    expect(result.mode).toBe('timings')
    expect(result.entries.map(entry => entry.kind)).toEqual(['appointments', 'login'])
    expect(result.entries[0]).toMatchObject({ userId: 22135, source: 'live', total: 250 })
  })

  it('answers only the entries of the given Strapi user ids', async () => {
    recordTiming({ kind: 'appointments', userId: 1, source: 'live', ok: true, total: 1, steps: [] })
    recordTiming({ kind: 'appointments', userId: 22135, source: 'live', ok: true, total: 2, steps: [] })

    const result = await runFionaSync({ mode: 'timings', userIds: [22135] })

    expect(result.entries.map(entry => entry.total)).toEqual([2])
  })
})
