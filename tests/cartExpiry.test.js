import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { checkoutTimeoutSeconds, checkoutCartExpiry, checkoutCartExpired } from '../server/utils/cartExpiry.js'

const MIN = 60 * 1000
const NOW = new Date('2026-06-02T12:00:00.000Z').getTime()

describe('checkoutTimeoutSeconds', () => {
  it('parses HH:MM:SS', () => {
    expect(checkoutTimeoutSeconds('00:30:00')).toBe(1800)
    expect(checkoutTimeoutSeconds('01:00:00')).toBe(3600)
    expect(checkoutTimeoutSeconds('00:05:00')).toBe(300)
    expect(checkoutTimeoutSeconds('00:00:01')).toBe(1)
  })

  it('parses MM:SS', () => {
    expect(checkoutTimeoutSeconds('30:00')).toBe(1800)
    expect(checkoutTimeoutSeconds('05:30')).toBe(330)
  })

  it('accepts a number directly', () => {
    expect(checkoutTimeoutSeconds(600)).toBe(600)
    expect(checkoutTimeoutSeconds(0)).toBe(0)
  })

  it('clamps negative numbers to 0', () => {
    expect(checkoutTimeoutSeconds(-100)).toBe(0)
  })

  it('defaults to 1800 when absent or empty', () => {
    expect(checkoutTimeoutSeconds()).toBe(1800)
    expect(checkoutTimeoutSeconds(undefined)).toBe(1800)
    expect(checkoutTimeoutSeconds('')).toBe(1800)
    expect(checkoutTimeoutSeconds(null)).toBe(1800)
  })

  it('defaults to 1800 for a non-numeric string', () => {
    expect(checkoutTimeoutSeconds('invalid')).toBe(1800)
  })

  it('handles a single-segment string', () => {
    // '30' → [30] → parts[0] = 30
    expect(checkoutTimeoutSeconds('30')).toBe(30)
  })
})

describe('checkoutCartExpiry', () => {
  beforeEach(() => { vi.setSystemTime(NOW) })
  afterEach(() => { vi.useRealTimers() })

  it('returns correct secondsRemaining for active cart', () => {
    const cart = { cartUpdatedAt: new Date(NOW - 5 * MIN).toISOString(), cartTimeout: '00:30:00' }
    const expiry = checkoutCartExpiry(cart)
    expect(expiry.secondsRemaining).toBe(25 * 60)
    expect(expiry.timeoutSeconds).toBe(1800)
    expect(new Date(expiry.expiresAt).getTime()).toBe(NOW - 5 * MIN + 30 * MIN)
  })

  it('returns 0 for expired cart', () => {
    const cart = { cartUpdatedAt: new Date(NOW - 31 * MIN).toISOString(), cartTimeout: '00:30:00' }
    expect(checkoutCartExpiry(cart).secondsRemaining).toBe(0)
  })

  it('returns 0 at exact expiry boundary', () => {
    const cart = { cartUpdatedAt: new Date(NOW - 30 * MIN).toISOString(), cartTimeout: '00:30:00' }
    expect(checkoutCartExpiry(cart).secondsRemaining).toBe(0)
  })

  it('returns 1 one second before expiry', () => {
    const cart = { cartUpdatedAt: new Date(NOW - 30 * MIN + 1000).toISOString(), cartTimeout: '00:30:00' }
    expect(checkoutCartExpiry(cart).secondsRemaining).toBe(1)
  })

  it('falls back to updated_at when cartUpdatedAt missing', () => {
    const cart = { updated_at: new Date(NOW - 10 * MIN).toISOString(), cartTimeout: '00:30:00' }
    expect(checkoutCartExpiry(cart).secondsRemaining).toBe(20 * 60)
  })

  it('falls back to updatedAt (camelCase) when cartUpdatedAt missing', () => {
    const cart = { updatedAt: new Date(NOW - 10 * MIN).toISOString(), cartTimeout: '00:30:00' }
    expect(checkoutCartExpiry(cart).secondsRemaining).toBe(20 * 60)
  })

  it('returns secondsRemaining 0 and null expiresAt when no timestamp', () => {
    const expiry = checkoutCartExpiry({ cartTimeout: '00:30:00' })
    expect(expiry.secondsRemaining).toBe(0)
    expect(expiry.expiresAt).toBeNull()
  })

  it('returns 0 for null/undefined cart', () => {
    expect(checkoutCartExpiry(null).secondsRemaining).toBe(0)
    expect(checkoutCartExpiry(undefined).secondsRemaining).toBe(0)
  })

  it('uses default 30min timeout when cartTimeout absent', () => {
    const cart = { cartUpdatedAt: new Date(NOW - 5 * MIN).toISOString() }
    expect(checkoutCartExpiry(cart).secondsRemaining).toBe(25 * 60)
  })

  it('respects custom cartTimeout', () => {
    const cart = { cartUpdatedAt: new Date(NOW - 3 * MIN).toISOString(), cartTimeout: '00:05:00' }
    expect(checkoutCartExpiry(cart).secondsRemaining).toBe(2 * 60)
  })

  it('handles future cartUpdatedAt gracefully', () => {
    const cart = { cartUpdatedAt: new Date(NOW + 5 * MIN).toISOString(), cartTimeout: '00:30:00' }
    // updatedAt is in the future — expiresAt is 35 min from now
    expect(checkoutCartExpiry(cart).secondsRemaining).toBe(35 * 60)
  })
})

describe('checkoutCartExpired', () => {
  beforeEach(() => { vi.setSystemTime(NOW) })
  afterEach(() => { vi.useRealTimers() })

  it('returns false for a cart with time remaining', () => {
    const cart = { cartUpdatedAt: new Date(NOW - 5 * MIN).toISOString(), cartTimeout: '00:30:00' }
    expect(checkoutCartExpired(cart)).toBe(false)
  })

  it('returns true for an expired cart', () => {
    const cart = { cartUpdatedAt: new Date(NOW - 35 * MIN).toISOString(), cartTimeout: '00:30:00' }
    expect(checkoutCartExpired(cart)).toBe(true)
  })

  it('returns true at exact expiry (secondsRemaining is 0)', () => {
    const cart = { cartUpdatedAt: new Date(NOW - 30 * MIN).toISOString(), cartTimeout: '00:30:00' }
    expect(checkoutCartExpired(cart)).toBe(true)
  })

  it('returns false one second before expiry', () => {
    const cart = { cartUpdatedAt: new Date(NOW - 30 * MIN + 1000).toISOString(), cartTimeout: '00:30:00' }
    expect(checkoutCartExpired(cart)).toBe(false)
  })

  it('returns true for a cart with no timestamp', () => {
    expect(checkoutCartExpired({})).toBe(true)
  })

  it('returns true for null/undefined', () => {
    expect(checkoutCartExpired(null)).toBe(true)
    expect(checkoutCartExpired(undefined)).toBe(true)
  })
})
