/**
 * Pure helper functions used inside checkout components.
 * Tested in isolation — no mounting, no DOM needed.
 *
 * These functions control what the customer sees in the UI:
 * prices, billing profile names, image display.
 */
import { describe, it, expect } from 'vitest'

// ─── formatPrice (used in OrderSummary, PaymentStep, ItemStep) ────────────────

function formatPrice(value) {
  return `${Number(value || 0).toFixed(2)} €`
}

describe('formatPrice', () => {
  it('formats a whole number price', () => {
    expect(formatPrice(100)).toBe('100.00 €')
  })

  it('formats a decimal price', () => {
    expect(formatPrice(19.9)).toBe('19.90 €')
    expect(formatPrice(80.5)).toBe('80.50 €')
  })

  it('formats zero as 0.00', () => {
    expect(formatPrice(0)).toBe('0.00 €')
  })

  it('formats null/undefined as 0.00 (no crash for missing price)', () => {
    expect(formatPrice(null)).toBe('0.00 €')
    expect(formatPrice(undefined)).toBe('0.00 €')
  })

  it('formats a string number', () => {
    expect(formatPrice('250')).toBe('250.00 €')
  })

  it('formats large ticket prices', () => {
    expect(formatPrice(1234.56)).toBe('1234.56 €')
  })

  it('rounds to 2 decimal places', () => {
    expect(formatPrice(10.009)).toBe('10.01 €')
    expect(formatPrice(10.001)).toBe('10.00 €')
  })
})

// ─── profileTitle (CheckoutPaymentStep) ──────────────────────────────────────

function profileTitle(profile) {
  if (!profile) return ''
  return profile.org_name ||
    profile.firstNameLastName ||
    [profile.firstName, profile.lastName].filter(Boolean).join(' ') ||
    `#${profile.id}`
}

describe('profileTitle', () => {
  it('returns empty string for null/undefined profile', () => {
    expect(profileTitle(null)).toBe('')
    expect(profileTitle(undefined)).toBe('')
  })

  it('prefers org_name for organisation profiles', () => {
    expect(profileTitle({ org_name: 'PÖFF OÜ', firstName: 'Jaan' })).toBe('PÖFF OÜ')
  })

  it('uses firstNameLastName when available (pre-joined name from Strapi)', () => {
    expect(profileTitle({ firstNameLastName: 'Jaan Tamm', firstName: 'Jaan', lastName: 'Tamm' })).toBe('Jaan Tamm')
  })

  it('joins firstName and lastName when no prejoined name', () => {
    expect(profileTitle({ firstName: 'Jaan', lastName: 'Tamm' })).toBe('Jaan Tamm')
  })

  it('uses only firstName if lastName is missing', () => {
    expect(profileTitle({ firstName: 'Jaan' })).toBe('Jaan')
  })

  it('uses only lastName if firstName is missing', () => {
    expect(profileTitle({ lastName: 'Tamm' })).toBe('Tamm')
  })

  it('falls back to #id when no name fields are available', () => {
    expect(profileTitle({ id: 42 })).toBe('#42')
  })

  it('handles profile with empty string name fields', () => {
    expect(profileTitle({ firstName: '', lastName: '', id: 7 })).toBe('#7')
  })
})

// ─── VAT calculation (CheckoutOrderSummary / index.vue) ──────────────────────

function vatAmount(total) {
  return Number(total || 0) * 24 / 124
}

describe('vatAmount (24% VAT included in price, Estonian standard)', () => {
  it('calculates VAT correctly for 100€ total', () => {
    expect(vatAmount(100)).toBeCloseTo(19.35, 2)
  })

  it('calculates VAT correctly for 280€ (test order total)', () => {
    expect(vatAmount(280)).toBeCloseTo(54.19, 2)
  })

  it('returns 0 for zero total', () => {
    expect(vatAmount(0)).toBe(0)
  })

  it('returns 0 for null/undefined', () => {
    expect(vatAmount(null)).toBe(0)
    expect(vatAmount(undefined)).toBe(0)
  })

  it('gross - VAT = net (sanity check)', () => {
    const total = 100
    const vat = vatAmount(total)
    const net = total - vat
    expect(net).toBeCloseTo(80.65, 2)
  })
})

// ─── hasItemImage (CheckoutOrderSummary) ─────────────────────────────────────

function hasItemImage(item) {
  return Boolean(item.imageUrl)
}

describe('hasItemImage', () => {
  it('returns true when imageUrl is set', () => {
    expect(hasItemImage({ imageUrl: 'https://cdn.poff.ee/pass.jpg' })).toBe(true)
  })

  it('returns false when imageUrl is null', () => {
    expect(hasItemImage({ imageUrl: null })).toBe(false)
  })

  it('returns false when imageUrl is empty string', () => {
    expect(hasItemImage({ imageUrl: '' })).toBe(false)
  })

  it('returns false when imageUrl is missing', () => {
    expect(hasItemImage({})).toBe(false)
  })
})

// ─── Checkout copy i18n fallback (useCheckoutCopy) ───────────────────────────

describe('checkout copy locale selection', () => {
  // The copy composable returns Estonian by default — verify the shape
  // expected by components so a bad locale doesn't crash the UI

  async function getCopy(locale) {
    const mod = await import('../pages/checkout/composables/useCheckoutCopy.js')
    const { ref } = await import('vue')
    const localeRef = ref(locale)
    return mod.useCheckoutCopy(localeRef).value
  }

  it('returns Estonian copy for "et"', async () => {
    const copy = await getCopy('et')
    expect(copy.backToShop).toBeTruthy()
    expect(copy.completeOrder).toBeTruthy()
    expect(copy.keepCart).toBeTruthy()
    expect(copy.sessionExpiredTitle).toBeTruthy()
  })

  it('returns English copy for "en"', async () => {
    const copy = await getCopy('en')
    expect(copy.backToShop).toBeTruthy()
    expect(copy.keepCart).toBeTruthy()
  })

  it('falls back gracefully for unknown locale', async () => {
    const copy = await getCopy('fr')
    // Must not crash; returns some locale's copy
    expect(copy).toBeTruthy()
    expect(copy.backToShop).toBeTruthy()
  })

  it('copy object contains all keys needed by components', async () => {
    const copy = await getCopy('et')
    const requiredKeys = [
      'backToShop', 'completeOrder', 'order', 'details', 'invoice', 'payStep',
      'keepCart', 'dismiss', 'sessionExpiredTitle', 'sessionExpiredText',
      'sessionAboutToExpire', 'sessionClearedIn', 'holdCart', 'sessionHurry',
      'sessionFewMinutes', 'sessionFinal', 'total', 'subtotal', 'vatIncluded',
      'session', 'empty', 'payment', 'confirmPurchase', 'itemCount',
      'chooseInvoiceProfile', 'total'
    ]
    for (const key of requiredKeys) {
      expect(copy[key], `copy.${key} should exist`).toBeTruthy()
    }
  })
})
