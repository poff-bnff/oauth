/**
 * runFionaSync in "auto" mode (what the cron calls every minute) backs off after a failed run, so a Strapi that is struggling
 * is not hit by the same heavy read again at once. Manual modes are never held back, and "status" shows the back-off.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

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
let runSync

beforeEach(async () => {
  vi.useFakeTimers({ now: new Date('2026-11-12T16:00:00Z'), toFake: ['Date'] })
  // fionaSync.js reads the runtime config once, when it is loaded: give it a Fiona key so the client can be built
  globalThis.useRuntimeConfig = () => ({ strapiUrl: 'http://localhost:1337', fionaApiKey: 'test-key' })
  vi.resetModules()
  ;({ runSync } = await import('../server/utils/fiona/sync.js'))
  runSync.mockReset()
  ;({ runFionaSync } = await import('../server/utils/fionaSync.js'))
})

afterEach(() => { vi.useRealTimers() })

describe('runFionaSync auto mode back-off', () => {
  it('skips the next auto run, saying why, after one failed', async () => {
    runSync.mockRejectedValueOnce(new Error('[GET] "https://admin.poff.ee/people?fiona_person_id_null=false&_limit=-1": 504 Gateway Time-out'))

    await expect(runFionaSync({ mode: 'auto' })).rejects.toThrow('504')
    const second = await runFionaSync({ mode: 'auto' })

    expect(second).toMatchObject({ mode: 'auto', skipped: true })
    expect(second.reason).toBe('backing off after 1 failed run - the next try is at 2026-11-12T16:15:00.000Z')
    expect(runSync).toHaveBeenCalledTimes(1)
  })

  it('runs again after the wait, and a success clears the failures', async () => {
    runSync.mockRejectedValueOnce(new Error('504')).mockResolvedValueOnce({ skipped: false }).mockRejectedValueOnce(new Error('504'))

    await expect(runFionaSync({ mode: 'auto' })).rejects.toThrow('504')
    vi.setSystemTime(new Date('2026-11-12T16:15:00Z'))
    await runFionaSync({ mode: 'auto' })
    expect(runSync).toHaveBeenCalledTimes(2)

    // the failure after a success waits 15 minutes again, not 30
    await expect(runFionaSync({ mode: 'auto' })).rejects.toThrow('504')
    const held = await runFionaSync({ mode: 'auto' })
    expect(held.reason).toBe('backing off after 1 failed run - the next try is at 2026-11-12T16:30:00.000Z')
  })

  it('does not count an auto run that was simply not due as a success or a failure', async () => {
    runSync.mockRejectedValueOnce(new Error('504')).mockResolvedValueOnce({ skipped: true, reason: 'not due' }).mockRejectedValueOnce(new Error('504'))

    await expect(runFionaSync({ mode: 'auto' })).rejects.toThrow('504')
    vi.setSystemTime(new Date('2026-11-12T16:15:00Z'))
    await runFionaSync({ mode: 'auto' }) // not due: failures stay at 1
    await expect(runFionaSync({ mode: 'auto' })).rejects.toThrow('504')

    const held = await runFionaSync({ mode: 'auto' })
    expect(held.reason).toBe('backing off after 2 failed runs - the next try is at 2026-11-12T16:45:00.000Z')
  })

  it('never holds back a manual run', async () => {
    runSync.mockRejectedValueOnce(new Error('504')).mockResolvedValue({ skipped: false })

    await expect(runFionaSync({ mode: 'auto' })).rejects.toThrow('504')
    await runFionaSync({ mode: 'full', dryRun: true })
    await runFionaSync({ mode: 'incremental', dryRun: true })

    expect(runSync).toHaveBeenCalledTimes(3)
  })

  it('shows the back-off in the status answer', async () => {
    runSync.mockRejectedValueOnce(new Error('504'))
    expect((await runFionaSync({ mode: 'status' })).backoff).toEqual({ failures: 0, retryAt: null })

    await expect(runFionaSync({ mode: 'auto' })).rejects.toThrow('504')

    expect((await runFionaSync({ mode: 'status' })).backoff).toEqual({ failures: 1, retryAt: '2026-11-12T16:15:00.000Z' })
  })
})
