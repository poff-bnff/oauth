/**
 * STEP 4 (perf) — getCheckoutCategoryAvailability uses a cheap /products/count instead of
 * hydrating up to ~50 product rows, while keeping the same response shape.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { getCheckoutCategoryAvailability } from '../server/utils/strapi.js'

const NOW = '2026-06-02T12:00:00.000Z'
const PERIOD = { startDateTime: '2026-01-01T00:00:00.000Z', endDateTime: '2027-01-01T00:00:00.000Z' }

const ADMIN_JWT_PAYLOAD = Buffer.from(JSON.stringify({ exp: Math.floor(new Date(NOW).getTime() / 1000) + 3600 })).toString('base64url')
const ADMIN_TOKEN_RESPONSE = { data: { token: `eyJhbGciOiJIUzI1NiJ9.${ADMIN_JWT_PAYLOAD}.sig` } }

const CATEGORY = {
  id: 109,
  codePrefix: 'LOCAL-INVOICE-TEST-2026',
  priceAtPeriod: [{ ...PERIOD, price: 100 }],
  salesPeriod: [PERIOD],
  cartLimit: null
}

function setup ({ count }) {
  const calls = []
  globalThis.$fetch = vi.fn().mockImplementation(async (url) => {
    calls.push(url)
    if (url.includes('/admin/login')) return ADMIN_TOKEN_RESPONSE
    if (url.includes('/product-categories/')) return CATEGORY
    if (url.includes('/products/count')) return count
    throw new Error(`Unmocked $fetch call: ${url}`)
  })
  return { calls }
}

beforeEach(() => {
  vi.setSystemTime(new Date(NOW)) // keep the category's sales/price period active
  globalThis.$fetch = vi.fn()
})
afterEach(() => { vi.useRealTimers() })

describe('getCheckoutCategoryAvailability (STEP 4)', () => {
  it('reports availability via /products/count, no product-row hydration', async () => {
    const { calls } = setup({ count: 5 })
    const result = await getCheckoutCategoryAvailability(null, 109)

    expect(result).toEqual({ availableCount: 5, cartLimit: null, inCart: 0, reasons: [] })
    expect(calls.some(u => u.includes('/products/count'))).toBe(true)
    // It must NOT hydrate a product list (the old up-to-50-row fetch).
    expect(calls.some(u => /\/products\?/.test(u) && u.includes('_limit'))).toBe(false)
  })

  it('flags soldOut when the count is zero', async () => {
    setup({ count: 0 })
    const result = await getCheckoutCategoryAvailability(null, 109)

    expect(result.availableCount).toBe(0)
    expect(result.reasons).toContain('soldOut')
  })

  it('caches the category across calls but keeps the stock count fresh (STEP 4c)', async () => {
    const { calls } = setup({ count: 3 })
    await getCheckoutCategoryAvailability(null, 109)
    await getCheckoutCategoryAvailability(null, 109)

    expect(calls.filter(u => u.includes('/product-categories/')).length).toBe(1) // fetched once, then cached
    expect(calls.filter(u => u.includes('/products/count')).length).toBe(2)      // re-counted every call
  })
})
