import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const {
  mockGetCleanupState,
  mockSaveCleanupState,
  mockRunStartupCartRecovery,
  mockExpireStaleCheckoutCarts
} = vi.hoisted(() => ({
  mockGetCleanupState: vi.fn(),
  mockSaveCleanupState: vi.fn(),
  mockRunStartupCartRecovery: vi.fn(),
  mockExpireStaleCheckoutCarts: vi.fn()
}))

vi.mock('../server/utils/strapi.js', () => ({
  getCleanupState: mockGetCleanupState,
  saveCleanupState: mockSaveCleanupState,
  runStartupCartRecovery: mockRunStartupCartRecovery,
  expireStaleCheckoutCarts: mockExpireStaleCheckoutCarts
}))

// No top-level plugin import — each describe block loads a fresh module via
// vi.resetModules() so the module-level cleanupIntervalId starts at null.

const NOW = new Date('2026-06-02T12:00:00.000Z').getTime()
const MIN = 60 * 1000
const THRESHOLD = 5 * MIN
const INTERVAL = 5 * MIN

function makeNitroApp() {
  return { hooks: { hookOnce: vi.fn() } }
}

// ─── Startup recovery ──────────────────────────────────────────────────────────

describe('cleanup plugin — startup recovery', () => {
  let cleanupPlugin

  beforeEach(async () => {
    vi.resetModules()
    vi.setSystemTime(NOW)
    vi.clearAllMocks()
    mockSaveCleanupState.mockResolvedValue({ lastCleanupRun: new Date(NOW).toISOString() })
    mockRunStartupCartRecovery.mockResolvedValue(3)
    mockExpireStaleCheckoutCarts.mockResolvedValue({ checked: 5, expired: 0 })
    const mod = await import('../server/plugins/cleanup.js')
    cleanupPlugin = mod.default
  })

  afterEach(() => { vi.useRealTimers() })

  it('runs recovery when gap exceeds 5 min threshold', async () => {
    mockGetCleanupState.mockResolvedValue({ lastCleanupRun: new Date(NOW - 10 * MIN).toISOString() })
    await cleanupPlugin(makeNitroApp())
    expect(mockRunStartupCartRecovery).toHaveBeenCalledOnce()
    expect(mockSaveCleanupState).toHaveBeenCalledWith({ lastCleanupRun: expect.any(String) })
  })

  it('runs recovery at exactly 5min + 1ms over threshold', async () => {
    mockGetCleanupState.mockResolvedValue({ lastCleanupRun: new Date(NOW - THRESHOLD - 1).toISOString() })
    await cleanupPlugin(makeNitroApp())
    expect(mockRunStartupCartRecovery).toHaveBeenCalledOnce()
  })

  it('skips recovery at exactly the threshold boundary', async () => {
    mockGetCleanupState.mockResolvedValue({ lastCleanupRun: new Date(NOW - THRESHOLD).toISOString() })
    await cleanupPlugin(makeNitroApp())
    expect(mockRunStartupCartRecovery).not.toHaveBeenCalled()
  })

  it('skips recovery when gap is within threshold', async () => {
    mockGetCleanupState.mockResolvedValue({ lastCleanupRun: new Date(NOW - 2 * MIN).toISOString() })
    await cleanupPlugin(makeNitroApp())
    expect(mockRunStartupCartRecovery).not.toHaveBeenCalled()
  })

  it('skips recovery when state is null (first startup)', async () => {
    mockGetCleanupState.mockResolvedValue(null)
    await cleanupPlugin(makeNitroApp())
    expect(mockRunStartupCartRecovery).not.toHaveBeenCalled()
  })

  it('skips recovery when lastCleanupRun is null', async () => {
    mockGetCleanupState.mockResolvedValue({ lastCleanupRun: null })
    await cleanupPlugin(makeNitroApp())
    expect(mockRunStartupCartRecovery).not.toHaveBeenCalled()
  })

  it('skips recovery when state is empty object', async () => {
    mockGetCleanupState.mockResolvedValue({})
    await cleanupPlugin(makeNitroApp())
    expect(mockRunStartupCartRecovery).not.toHaveBeenCalled()
  })

  it('continues gracefully when getCleanupState throws', async () => {
    mockGetCleanupState.mockRejectedValue(new Error('Strapi unreachable'))
    await expect(cleanupPlugin(makeNitroApp())).resolves.not.toThrow()
    expect(mockRunStartupCartRecovery).not.toHaveBeenCalled()
  })

  it('continues gracefully when runStartupCartRecovery throws', async () => {
    mockGetCleanupState.mockResolvedValue({ lastCleanupRun: new Date(NOW - 10 * MIN).toISOString() })
    mockRunStartupCartRecovery.mockRejectedValue(new Error('DB error'))
    await expect(cleanupPlugin(makeNitroApp())).resolves.not.toThrow()
  })
})

// ─── Scheduled job (production) ────────────────────────────────────────────────

describe('cleanup plugin — scheduled job (production)', () => {
  let cleanupPlugin

  beforeEach(async () => {
    vi.resetModules()
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
    vi.clearAllMocks()
    vi.stubEnv('NODE_ENV', 'production')
    mockGetCleanupState.mockResolvedValue({ lastCleanupRun: new Date(NOW - 2 * MIN).toISOString() })
    mockSaveCleanupState.mockResolvedValue({ lastCleanupRun: new Date(NOW).toISOString() })
    mockRunStartupCartRecovery.mockResolvedValue(3)
    mockExpireStaleCheckoutCarts.mockResolvedValue({ checked: 5, expired: 2 })
    const mod = await import('../server/plugins/cleanup.js')
    cleanupPlugin = mod.default
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    vi.useRealTimers()
  })

  it('registers shutdown hook in production', async () => {
    const nitroApp = makeNitroApp()
    await cleanupPlugin(nitroApp)
    expect(nitroApp.hooks.hookOnce).toHaveBeenCalledWith('close', expect.any(Function))
  })

  it('runs initial cleanup after startup when no recovery needed', async () => {
    await cleanupPlugin(makeNitroApp())
    expect(mockExpireStaleCheckoutCarts).toHaveBeenCalledOnce()
  })

  it('saves state after successful initial cleanup', async () => {
    await cleanupPlugin(makeNitroApp())
    expect(mockSaveCleanupState).toHaveBeenCalledWith({ lastCleanupRun: expect.any(String) })
  })

  it('does not save state when initial cleanup throws', async () => {
    mockExpireStaleCheckoutCarts.mockRejectedValue(new Error('DB error'))
    await cleanupPlugin(makeNitroApp())
    expect(mockSaveCleanupState).not.toHaveBeenCalled()
  })

  it('runs cleanup on each interval tick', async () => {
    await cleanupPlugin(makeNitroApp())
    mockExpireStaleCheckoutCarts.mockClear()
    mockSaveCleanupState.mockClear()
    await vi.advanceTimersByTimeAsync(INTERVAL + 100)
    expect(mockExpireStaleCheckoutCarts).toHaveBeenCalledOnce()
    expect(mockSaveCleanupState).toHaveBeenCalledOnce()
  })

  it('does not save state when interval cleanup throws', async () => {
    await cleanupPlugin(makeNitroApp())
    mockExpireStaleCheckoutCarts.mockRejectedValue(new Error('DB error'))
    mockSaveCleanupState.mockClear()
    await vi.advanceTimersByTimeAsync(INTERVAL + 100)
    expect(mockSaveCleanupState).not.toHaveBeenCalled()
  })

  it('does not run initial cleanup when recovery was performed', async () => {
    mockGetCleanupState.mockResolvedValue({ lastCleanupRun: new Date(NOW - 10 * MIN).toISOString() })
    await cleanupPlugin(makeNitroApp())
    expect(mockExpireStaleCheckoutCarts).not.toHaveBeenCalled()
  })
})

// ─── Dev mode ──────────────────────────────────────────────────────────────────

describe('cleanup plugin — dev mode', () => {
  let cleanupPlugin

  beforeEach(async () => {
    vi.resetModules()
    vi.clearAllMocks()
    vi.stubEnv('NODE_ENV', 'development')
    mockGetCleanupState.mockResolvedValue({ lastCleanupRun: new Date(NOW - 2 * MIN).toISOString() })
    mockSaveCleanupState.mockResolvedValue({})
    mockExpireStaleCheckoutCarts.mockResolvedValue({ checked: 0, expired: 0 })
    const mod = await import('../server/plugins/cleanup.js')
    cleanupPlugin = mod.default
  })

  afterEach(() => { vi.unstubAllEnvs() })

  it('still runs startup recovery in dev mode', async () => {
    mockGetCleanupState.mockResolvedValue({ lastCleanupRun: new Date(NOW - 10 * MIN).toISOString() })
    await cleanupPlugin(makeNitroApp())
    expect(mockRunStartupCartRecovery).toHaveBeenCalledOnce()
  })

  it('does not register shutdown hook in dev mode', async () => {
    const nitroApp = makeNitroApp()
    await cleanupPlugin(nitroApp)
    expect(nitroApp.hooks.hookOnce).not.toHaveBeenCalled()
  })

  it('does not run initial cleanup in dev mode', async () => {
    await cleanupPlugin(makeNitroApp())
    expect(mockExpireStaleCheckoutCarts).not.toHaveBeenCalled()
  })
})
