import { describe, it, expect, beforeEach, vi } from 'vitest'
import { hitLimit } from '../server/utils/rateLimiter.js'

// Each test gets a unique key prefix to avoid window state bleeding between tests.
let keySeq = 0
function freshKey() { return `test-${keySeq++}` }

beforeEach(() => {
  vi.useFakeTimers()
})

describe('hitLimit', () => {
  it('does not exceed for first N requests within a window', () => {
    const key = freshKey()
    for (let i = 0; i < 5; i++) {
      const result = hitLimit(key, 5, 60_000)
      expect(result.exceeded).toBe(false)
    }
  })

  it('exceeds on the (max + 1)th request within the same window', () => {
    const key = freshKey()
    for (let i = 0; i < 5; i++) hitLimit(key, 5, 60_000)
    const result = hitLimit(key, 5, 60_000)
    expect(result.exceeded).toBe(true)
  })

  it('returns retryAfter in seconds (≥ 1)', () => {
    const key = freshKey()
    for (let i = 0; i < 6; i++) hitLimit(key, 5, 60_000)
    const result = hitLimit(key, 5, 60_000)
    expect(result.retryAfter).toBeGreaterThanOrEqual(1)
  })

  it('resets count after the window expires', () => {
    const key = freshKey()
    for (let i = 0; i < 6; i++) hitLimit(key, 5, 60_000)
    expect(hitLimit(key, 5, 60_000).exceeded).toBe(true)

    // Advance past the window
    vi.advanceTimersByTime(61_000)

    // Counter resets — first request in new window is fine
    expect(hitLimit(key, 5, 60_000).exceeded).toBe(false)
  })

  it('different keys are tracked independently', () => {
    const keyA = freshKey()
    const keyB = freshKey()
    for (let i = 0; i < 6; i++) hitLimit(keyA, 5, 60_000)
    expect(hitLimit(keyA, 5, 60_000).exceeded).toBe(true)
    expect(hitLimit(keyB, 5, 60_000).exceeded).toBe(false)
  })
})
