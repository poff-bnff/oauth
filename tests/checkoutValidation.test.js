/**
 * Pure checkout validation rules — no Strapi calls, no mocks.
 * These tests document the exact business rules a customer bumps into.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  hasCompleteCheckoutBuyerProfile,
  missingBuyerProfileFields,
  validateCheckoutDeliveryLocation,
  getCheckoutProductCurrentPrice
} from '../server/utils/strapi.js'

const NOW = new Date('2026-06-02T12:00:00.000Z')

const COMPLETE_PROFILE = {
  email: 'jaan@example.ee',
  firstName: 'Jaan',
  lastName: 'Tamm',
  birthdate: '1990-01-01',
  phoneNr: '+3725551234',
  gender: 'male',
  picture: 'https://cdn.poff.ee/pic.jpg'
}

// ─── Buyer profile completeness ───────────────────────────────────────────────

describe('hasCompleteCheckoutBuyerProfile', () => {
  it('accepts a fully filled profile', () => {
    expect(hasCompleteCheckoutBuyerProfile(COMPLETE_PROFILE)).toBe(true)
  })

  it('rejects empty profile', () => {
    expect(hasCompleteCheckoutBuyerProfile({})).toBe(false)
  })

  it('rejects undefined (default param)', () => {
    expect(hasCompleteCheckoutBuyerProfile()).toBe(false)
  })

  // Each required field — customer must supply every one of these
  for (const field of ['email', 'firstName', 'lastName', 'birthdate', 'phoneNr', 'gender', 'picture']) {
    it(`rejects profile missing ${field}`, () => {
      const profile = { ...COMPLETE_PROFILE, [field]: undefined }
      expect(hasCompleteCheckoutBuyerProfile(profile)).toBe(false)
    })

    it(`rejects profile with empty string ${field}`, () => {
      const profile = { ...COMPLETE_PROFILE, [field]: '' }
      expect(hasCompleteCheckoutBuyerProfile(profile)).toBe(false)
    })
  }
})

// ─── Missing fields enumeration ───────────────────────────────────────────────

describe('missingBuyerProfileFields', () => {
  it('returns empty array for complete profile', () => {
    expect(missingBuyerProfileFields(COMPLETE_PROFILE)).toEqual([])
  })

  it('returns all 7 fields for empty profile', () => {
    const missing = missingBuyerProfileFields({})
    expect(missing).toHaveLength(7)
    expect(missing).toContain('email')
    expect(missing).toContain('birthdate')
    expect(missing).toContain('picture')
  })

  it('lists exactly the fields that are missing', () => {
    const profile = { ...COMPLETE_PROFILE, birthdate: '', gender: undefined }
    expect(missingBuyerProfileFields(profile)).toEqual(['birthdate', 'gender'])
  })

  it('treats falsy values (0, false, null) as missing', () => {
    const profile = { ...COMPLETE_PROFILE, gender: null, picture: false }
    const missing = missingBuyerProfileFields(profile)
    expect(missing).toContain('gender')
    expect(missing).toContain('picture')
  })
})

// ─── Delivery location validation ─────────────────────────────────────────────

describe('validateCheckoutDeliveryLocation', () => {
  const locations = [{ id: 10 }, { id: 20 }, { id: 30 }]

  it('returns null when category has no pickup locations (no location required)', () => {
    expect(validateCheckoutDeliveryLocation([], undefined)).toBeNull()
    expect(validateCheckoutDeliveryLocation(null, undefined)).toBeNull()
  })

  it('returns false when locations exist but none is selected', () => {
    expect(validateCheckoutDeliveryLocation(locations, undefined)).toBe(false)
    expect(validateCheckoutDeliveryLocation(locations, null)).toBe(false)
    expect(validateCheckoutDeliveryLocation(locations, '')).toBe(false)
  })

  it('returns the locationId when a valid location is selected', () => {
    expect(validateCheckoutDeliveryLocation(locations, 10)).toBe(10)
    expect(validateCheckoutDeliveryLocation(locations, 20)).toBe(20)
  })

  it('returns false when an unknown locationId is submitted', () => {
    expect(validateCheckoutDeliveryLocation(locations, 99)).toBe(false)
  })

  it('matches locations using string comparison (handles string vs number)', () => {
    expect(validateCheckoutDeliveryLocation(locations, '10')).toBe('10')
    expect(validateCheckoutDeliveryLocation(locations, '99')).toBe(false)
  })

  it('returns null for undefined locations list (handles edge input)', () => {
    expect(validateCheckoutDeliveryLocation(undefined, 10)).toBeNull()
  })
})

// ─── Price period lookup ───────────────────────────────────────────────────────

describe('getCheckoutProductCurrentPrice', () => {
  beforeEach(() => vi.setSystemTime(NOW))
  afterEach(() => vi.useRealTimers())

  it('returns undefined when category has no priceAtPeriod', () => {
    expect(getCheckoutProductCurrentPrice({})).toBeUndefined()
    expect(getCheckoutProductCurrentPrice(null)).toBeUndefined()
    expect(getCheckoutProductCurrentPrice(undefined)).toBeUndefined()
  })

  it('returns undefined when priceAtPeriod is empty', () => {
    expect(getCheckoutProductCurrentPrice({ priceAtPeriod: [] })).toBeUndefined()
  })

  it('returns price for an active period', () => {
    const category = {
      priceAtPeriod: [{
        startDateTime: new Date(NOW.getTime() - 60 * 60 * 1000).toISOString(), // 1h ago
        endDateTime:   new Date(NOW.getTime() + 60 * 60 * 1000).toISOString(), // 1h ahead
        price: 100
      }]
    }
    expect(getCheckoutProductCurrentPrice(category)).toBe(100)
  })

  it('returns undefined for a period that already ended', () => {
    const category = {
      priceAtPeriod: [{
        startDateTime: new Date(NOW.getTime() - 2 * 3600 * 1000).toISOString(),
        endDateTime:   new Date(NOW.getTime() - 1 * 3600 * 1000).toISOString(),
        price: 80
      }]
    }
    expect(getCheckoutProductCurrentPrice(category)).toBeUndefined()
  })

  it('returns undefined for a period that has not started yet', () => {
    const category = {
      priceAtPeriod: [{
        startDateTime: new Date(NOW.getTime() + 1 * 3600 * 1000).toISOString(),
        endDateTime:   new Date(NOW.getTime() + 2 * 3600 * 1000).toISOString(),
        price: 120
      }]
    }
    expect(getCheckoutProductCurrentPrice(category)).toBeUndefined()
  })

  it('picks the active period when multiple periods exist', () => {
    const category = {
      priceAtPeriod: [
        { startDateTime: new Date(NOW.getTime() - 48 * 3600 * 1000).toISOString(), endDateTime: new Date(NOW.getTime() - 24 * 3600 * 1000).toISOString(), price: 60 },
        { startDateTime: new Date(NOW.getTime() - 1 * 3600 * 1000).toISOString(),  endDateTime: new Date(NOW.getTime() + 1 * 3600 * 1000).toISOString(),  price: 100 },
        { startDateTime: new Date(NOW.getTime() + 24 * 3600 * 1000).toISOString(), endDateTime: new Date(NOW.getTime() + 48 * 3600 * 1000).toISOString(), price: 120 }
      ]
    }
    expect(getCheckoutProductCurrentPrice(category)).toBe(100)
  })

  it('returns undefined for a period missing startDateTime', () => {
    const category = {
      priceAtPeriod: [{
        endDateTime: new Date(NOW.getTime() + 3600 * 1000).toISOString(),
        price: 50
      }]
    }
    expect(getCheckoutProductCurrentPrice(category)).toBeUndefined()
  })

  it('handles price of 0 as a valid (free) price', () => {
    const category = {
      priceAtPeriod: [{
        startDateTime: new Date(NOW.getTime() - 3600 * 1000).toISOString(),
        endDateTime:   new Date(NOW.getTime() + 3600 * 1000).toISOString(),
        price: 0
      }]
    }
    // price=0 is falsy but valid — function returns the value, not coerces it
    expect(getCheckoutProductCurrentPrice(category)).toBe(0)
  })
})
