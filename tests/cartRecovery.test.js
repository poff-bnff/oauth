/**
 * BUG 7 — recover a cart stranded in 'checkout_started' by an abandoned payment.
 * $fetch is globally mocked in setup.js; the clock is pinned so the fresh cart isn't seen as expired.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { reactivateStrandedCheckoutCart } from '../server/utils/strapi.js'

const USER_ID = 29181
const NOW = '2026-06-02T12:00:00.000Z'

// Real-looking admin JWT (only the payload's exp must be valid) so the admin-token cache works.
const ADMIN_JWT_PAYLOAD = Buffer.from(JSON.stringify({ exp: Math.floor(new Date(NOW).getTime() / 1000) + 3600 })).toString('base64url')
const ADMIN_TOKEN_RESPONSE = { data: { token: `eyJhbGciOiJIUzI1NiJ9.${ADMIN_JWT_PAYLOAD}.sig` } }

const STRANDED_CART = {
  id: 77,
  cartProducts: [{ id: 100, product: 7255, priceInCart: 100, timeToCart: NOW }],
  cartUpdatedAt: NOW,
  cartTimeout: '00:30:00',
  cart_status: { id: 4, status: 'checkout_started' },
  users_permissions_user: { id: USER_ID }
}

// strandedList: what GET /carts returns; emptyProducts: override cartProducts to [].
function setup({ strandedList = [STRANDED_CART] } = {}) {
  const puts = []
  globalThis.$fetch = vi.fn().mockImplementation(async (url, opts = {}) => {
    if (url.includes('/admin/login')) return ADMIN_TOKEN_RESPONSE
    if (url.includes('/cart-statuses')) {
      if (url.includes('status=checkout_started')) return [{ id: 4, status: 'checkout_started' }]
      return [{ id: 1, status: 'active' }]
    }
    if (url.includes('/carts/') && opts.method === 'PUT') {
      puts.push({ url, body: opts.body })
      return { ...STRANDED_CART, cart_status: { id: 1, status: 'active' }, ...opts.body }
    }
    if (url.includes('/carts')) return strandedList
    throw new Error(`Unmocked $fetch call: ${url}`)
  })
  return { puts }
}

beforeEach(() => {
  vi.setSystemTime(new Date(NOW)) // keep STRANDED_CART (cartUpdatedAt: NOW) from looking expired
  globalThis.$fetch = vi.fn()
})
afterEach(() => { vi.useRealTimers() })

describe('reactivateStrandedCheckoutCart (BUG 7)', () => {
  it('reactivates a stranded checkout_started cart back to active', async () => {
    const { puts } = setup()
    const result = await reactivateStrandedCheckoutCart(USER_ID)

    expect(result).toBeTruthy()
    expect(puts).toHaveLength(1)
    expect(puts[0].url).toContain('/carts/77')
    expect(puts[0].body.cart_status).toBe(1) // flipped to the 'active' status id
  })

  it('does nothing when there is no stranded cart', async () => {
    const { puts } = setup({ strandedList: [] })
    const result = await reactivateStrandedCheckoutCart(USER_ID)

    expect(result).toBeNull()
    expect(puts).toHaveLength(0) // never resurrects / writes anything
  })

  it('does not recover an (empty) stranded cart with no products', async () => {
    const { puts } = setup({ strandedList: [{ ...STRANDED_CART, cartProducts: [] }] })
    const result = await reactivateStrandedCheckoutCart(USER_ID)

    expect(result).toBeNull()
    expect(puts).toHaveLength(0)
  })

  it('returns null for a missing user without touching the network', async () => {
    setup()
    expect(await reactivateStrandedCheckoutCart(null)).toBeNull()
    expect(globalThis.$fetch).not.toHaveBeenCalled()
  })
})
