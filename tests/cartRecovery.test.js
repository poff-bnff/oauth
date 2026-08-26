import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { reactivateStrandedCheckoutCart } from '../server/utils/strapi.js'

const USER_ID = 29181
const NOW = '2026-06-02T12:00:00.000Z'

const b64url = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url')
const ADMIN_TOKEN_RESPONSE = { data: { token: `${b64url({ alg: 'HS256', typ: 'JWT' })}.${b64url({ exp: Math.floor(new Date(NOW).getTime() / 1000) + 3600 })}.notarealsignature` } }

const STRANDED_CART = {
  id: 77,
  cartProducts: [{ id: 100, product: 7255, priceInCart: 100, timeToCart: NOW }],
  cartUpdatedAt: NOW,
  cartTimeout: '00:30:00',
  cart_status: { id: 4, status: 'checkout_started' },
  users_permissions_user: { id: USER_ID }
}

// Unsold by default: an abandoned cart holds products nobody owns yet. `products: 'sold'` models a
// cart that was just paid for, and `products: 'unreadable'` a Strapi that will not answer.
function setup({ strandedList = [STRANDED_CART], products = 'unsold' } = {}) {
  const puts = []
  globalThis.$fetch = vi.fn().mockImplementation(async (url, opts = {}) => {
    if (url.includes('/admin/login')) return ADMIN_TOKEN_RESPONSE
    if (url.includes('/products')) {
      if (products === 'unreadable') throw new Error('strapi unavailable')
      if (products === 'sold') return [{ id: 7255, owner: { id: USER_ID }, transactions: [{ id: 9 }] }]
      return [{ id: 7255, owner: null, transactions: [] }]
    }
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
  vi.setSystemTime(new Date(NOW))
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
    expect(puts[0].body.cart_status).toBe(1)
  })

  // Paying moves the cart to checkout_started and the Maksekeskus callback converts it moments
  // later. In that window the buyer is usually already back on the site, and recovery used to
  // restore their completed purchase to the basket — where checkout then failed to load, because
  // the products are sold.
  it('does not reactivate a cart whose products have already been sold', async () => {
    const { puts } = setup({ products: 'sold' })
    const result = await reactivateStrandedCheckoutCart(USER_ID)

    expect(result).toBeNull()
    expect(puts).toHaveLength(0)
  })

  it('does not reactivate when it cannot tell whether the products were sold', async () => {
    const { puts } = setup({ products: 'unreadable' })
    const result = await reactivateStrandedCheckoutCart(USER_ID)

    // Failing to recover an abandoned cart is a small inconvenience; putting a completed purchase
    // back in someone's basket is not.
    expect(result).toBeNull()
    expect(puts).toHaveLength(0)
  })

  it('does nothing when there is no stranded cart', async () => {
    const { puts } = setup({ strandedList: [] })
    const result = await reactivateStrandedCheckoutCart(USER_ID)

    expect(result).toBeNull()
    expect(puts).toHaveLength(0)
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
