/**
 * STEP 4d — the payment-method catalog is cached so getCheckoutContext doesn't hit the external
 * Maksekeskus API on every checkout load / 15s sync. (Cache is reset between tests in setup.js.)
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { getPaymentMethods } from '../server/utils/strapi.js'

const MK_CONFIG = {
  payment_methods: {
    banklinks: [{ name: 'seb', country: 'EE', logo_url: 'https://x/seb.png' }],
    cards: [], other: [], payLater: []
  }
}

beforeEach(() => { globalThis.$fetch = vi.fn() })

describe('getPaymentMethods caching', () => {
  it('fetches the Maksekeskus catalog once, then serves from cache', async () => {
    let mkCalls = 0
    globalThis.$fetch = vi.fn().mockImplementation(async (url) => {
      if (url.includes('/v1/shop/configuration')) { mkCalls++; return MK_CONFIG }
      throw new Error(`Unmocked $fetch call: ${url}`)
    })

    const first = await getPaymentMethods()
    const second = await getPaymentMethods()

    expect(mkCalls).toBe(1) // external API hit once, not per call
    expect(second).toEqual(first)
    expect(first.banklinks.length).toBe(1)
  })
})
