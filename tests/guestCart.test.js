/**
 * Guest cart tests — the anonymous (no JWT) add-to-cart path.
 * Key invariants (after the guest-reservation refactor):
 *   - null owner (brand-new guest) → creates cart, returns newCartToken
 *   - { cartToken } owner → appends to existing cart, no newCartToken on second add
 *   - Guests RESERVE products via /products/claim using their cart token (just like logged-in users)
 *   - Cart is capped at CART_LIMITS.maxItemsPerCart (50) items
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { addCheckoutCartItem } from '../server/utils/strapi.js'

const NOW = '2026-06-02T12:00:00.000Z'
const GUEST_TOKEN = 'guest-abc123'

const ACTIVE_PRICE_PERIOD = { startDateTime: '2026-01-01T00:00:00.000Z', endDateTime: '2027-01-01T00:00:00.000Z', price: 75 }
const ACTIVE_SALES_PERIOD = { startDateTime: '2026-01-01T00:00:00.000Z', endDateTime: '2027-01-01T00:00:00.000Z' }
const CATEGORY = {
  id: 200, codePrefix: 'GUEST-PASS-2026', namePrivate: 'Guest pass 2026',
  priceAtPeriod: [ACTIVE_PRICE_PERIOD], salesPeriod: [ACTIVE_SALES_PERIOD], pickup_locations: [], business_profile: { id: 7000 }
}
const PRODUCT_A = { id: 8001, code: 'GUEST-2026-0001', active: true, product_category: CATEGORY, reserved_to: null, sold_to: null }
const PRODUCT_B = { id: 8002, code: 'GUEST-2026-0002', active: true, product_category: CATEGORY, reserved_to: null, sold_to: null }

const ADMIN_JWT_PAYLOAD = Buffer.from(JSON.stringify({ exp: Math.floor(new Date(NOW).getTime() / 1000) + 3600 })).toString('base64url')
const ADMIN_JWT = `${Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url')}.${ADMIN_JWT_PAYLOAD}.sig`

function setupFetch (...handlers) {
  globalThis.$fetch = vi.fn().mockImplementation(async (url, opts) => {
    for (const h of handlers) {
      const result = h(url, opts)
      if (result !== undefined) return result
    }
    throw new Error(`Unmocked $fetch call: ${url}`)
  })
}

function adminTokenHandler (url) {
  if (url.includes('/admin/login')) return { data: { token: ADMIN_JWT } }
}
// Guest add claims via /products/claim with a cart token; return the given products as claimed.
const claimHandler = (claimed) => (url, opts) => {
  if (url.includes('/products/claim') && opts?.method === 'POST') return { mode: 'byCategory', got: claimed.length, claimed }
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date(NOW))
  globalThis.$fetch = vi.fn()
})
afterEach(() => { vi.useRealTimers() })

// ── Guest creates a brand-new cart ─────────────────────────────────────────────
describe('guest cart creation (null owner)', () => {
  it('creates a new guest cart and returns newCartToken', async () => {
    const cartWithProduct = {
      id: 500, cartProducts: [{ id: 900, product: PRODUCT_A, priceInCart: 75, timeToCart: NOW }],
      cartUpdatedAt: NOW, cartTimeout: null, cartToken: GUEST_TOKEN,
      cart_status: { id: 1, status: 'active' }, users_permissions_user: null, locale: 'et'
    }
    const emptyCart = { ...cartWithProduct, cartProducts: [] }
    setupFetch(
      adminTokenHandler,
      claimHandler([{ id: PRODUCT_A.id, code: PRODUCT_A.code }]),
      (url, opts) => {
        if (url.includes('/product-categories')) return CATEGORY
        if (url.includes('/cart-statuses')) return [{ id: 1, status: 'active' }]
        if (url.includes('/carts') && opts?.method === 'POST') return emptyCart
        if (url.includes('/carts/') && opts?.method === 'PUT') return cartWithProduct
      }
    )
    const result = await addCheckoutCartItem(null, { categoryId: 200 })
    expect(result.newCartToken).toBeTruthy()
  })

  it('adopts a client-provided guest token instead of minting a new one', async () => {
    const CLIENT_TOKEN = 'guesttoken-abcdef1234567890'
    let createdCartBody = null
    const cartWithProduct = {
      id: 510, cartProducts: [{ id: 910, product: PRODUCT_A, priceInCart: 75, timeToCart: NOW }],
      cartUpdatedAt: NOW, cartTimeout: null, cartToken: CLIENT_TOKEN,
      cart_status: { id: 1, status: 'active' }, users_permissions_user: null, locale: 'et'
    }
    const emptyCart = { ...cartWithProduct, cartProducts: [] }
    setupFetch(
      adminTokenHandler,
      claimHandler([{ id: PRODUCT_A.id, code: PRODUCT_A.code }]),
      (url, opts) => {
        if (url.includes('/product-categories')) return CATEGORY
        if (url.includes('/cart-statuses')) return [{ id: 1, status: 'active' }]
        if (url.includes('/carts/') && opts?.method === 'PUT') return cartWithProduct
        if (url.includes('/carts') && opts?.method === 'POST') { createdCartBody = opts.body; return emptyCart }
        if (url.includes('/carts')) return []
      }
    )
    const result = await addCheckoutCartItem({ cartToken: CLIENT_TOKEN }, { categoryId: 200 })
    expect(createdCartBody?.cartToken).toBe(CLIENT_TOKEN)
    expect(result.newCartToken).toBeUndefined()
  })

  it('reserves the product via /products/claim using the cart token (guests hold like users)', async () => {
    let claimBody = null
    const cartWithProduct = {
      id: 501, cartProducts: [{ id: 901, product: PRODUCT_A, priceInCart: 75, timeToCart: NOW }],
      cartUpdatedAt: NOW, cartToken: GUEST_TOKEN,
      cart_status: { id: 1, status: 'active' }, users_permissions_user: null, locale: 'et'
    }
    const emptyCart = { ...cartWithProduct, cartProducts: [] }
    setupFetch(
      adminTokenHandler,
      (url, opts) => {
        if (url.includes('/products/claim') && opts?.method === 'POST') { claimBody = opts.body; return { claimed: [{ id: PRODUCT_A.id, code: PRODUCT_A.code }] } }
        if (url.includes('/product-categories')) return CATEGORY
        if (url.includes('/cart-statuses')) return [{ id: 1, status: 'active' }]
        if (url.includes('/carts') && opts?.method === 'POST') return emptyCart
        if (url.includes('/carts/') && opts?.method === 'PUT') return cartWithProduct
        if (url.includes('/carts')) return [{ ...emptyCart }]
      }
    )
    await addCheckoutCartItem({ cartToken: GUEST_TOKEN }, { categoryId: 200 })
    expect(claimBody).toMatchObject({ categoryId: 200, cartToken: GUEST_TOKEN }) // reserved against the token
    expect(claimBody.userId).toBeUndefined()                                    // not a user claim
  })

  it('returns 404 noItems when the claim acquires nothing (guest)', async () => {
    setupFetch(
      adminTokenHandler,
      claimHandler([]), // claim returns no products
      (url, opts) => {
        if (url.includes('/product-categories')) return CATEGORY
        if (url.includes('/cart-statuses')) return [{ id: 1, status: 'active' }]
        if (url.includes('/carts') && opts?.method === 'POST') return { id: 502, cartProducts: [], cartToken: GUEST_TOKEN, cart_status: { id: 1, status: 'active' }, users_permissions_user: null }
      }
    )
    const result = await addCheckoutCartItem(null, { categoryId: 200 })
    expect(result).toMatchObject({ code: 404, case: 'noItems' })
  })
})

// ── Guest adds to existing cart (cartToken owner) ──────────────────────────────
describe('guest cart append ({ cartToken } owner)', () => {
  const existingCart = {
    id: 503, cartProducts: [{ id: 902, product: PRODUCT_A, priceInCart: 75, timeToCart: NOW }],
    cartUpdatedAt: NOW, cartToken: GUEST_TOKEN, cart_status: { id: 1, status: 'active' }, users_permissions_user: null, locale: 'et'
  }
  it('appends to the existing cart and does NOT return newCartToken', async () => {
    const afterAdd = {
      ...existingCart,
      cartProducts: [
        { id: 902, product: PRODUCT_A, priceInCart: 75, timeToCart: NOW },
        { id: 903, product: PRODUCT_B, priceInCart: 75, timeToCart: NOW }
      ]
    }
    setupFetch(
      adminTokenHandler,
      claimHandler([{ id: PRODUCT_B.id, code: PRODUCT_B.code }]),
      (url, opts) => {
        if (url.includes('/product-categories')) return CATEGORY
        if (url.includes('/cart-statuses')) return [{ id: 1, status: 'active' }]
        if (url.includes('/carts') && !url.includes('/carts/')) return [existingCart]
        if (url.includes('/carts/') && opts?.method === 'PUT') return afterAdd
      }
    )
    const result = await addCheckoutCartItem({ cartToken: GUEST_TOKEN }, { categoryId: 200 })
    expect(result.newCartToken).toBeUndefined()
    expect(result.items).toHaveLength(2)
  })
})

// ── maxItemsPerCart cap (returns before any claim) ─────────────────────────────
describe('guest cart item cap', () => {
  it('returns 400 cartFull when cart is already at maxItemsPerCart', async () => {
    const fullProducts = Array.from({ length: 50 }, (_, i) => ({ id: 9000 + i, product: { id: 8000 + i }, priceInCart: 75, timeToCart: NOW }))
    const fullCart = { id: 600, cartProducts: fullProducts, cartUpdatedAt: NOW, cartToken: GUEST_TOKEN, cart_status: { id: 1, status: 'active' }, users_permissions_user: null }
    setupFetch(adminTokenHandler, (url) => {
      if (url.includes('/product-categories')) return CATEGORY
      if (url.includes('/cart-statuses')) return [{ id: 1, status: 'active' }]
      if (url.includes('/carts') && !url.includes('/carts/')) return [fullCart]
    })
    const result = await addCheckoutCartItem({ cartToken: GUEST_TOKEN }, { categoryId: 200 })
    expect(result).toMatchObject({ code: 400, case: 'cartFull' })
  })
})

describe('per-category cart limit (returns before any claim)', () => {
  it('returns 400 categoryLimit when the category cartLimit is reached', async () => {
    const limitedCategory = { ...CATEGORY, cartLimit: 1 }
    const oneItemCart = { id: 601, cartProducts: [{ id: 9100, product: { id: 8001, product_category: CATEGORY }, priceInCart: 75, timeToCart: NOW }], cartUpdatedAt: NOW, cartToken: GUEST_TOKEN, cart_status: { id: 1, status: 'active' }, users_permissions_user: null }
    setupFetch(adminTokenHandler, (url) => {
      if (url.includes('/product-categories')) return limitedCategory
      if (url.includes('/cart-statuses')) return [{ id: 1, status: 'active' }]
      if (url.includes('/carts') && !url.includes('/carts/')) return [oneItemCart]
    })
    const result = await addCheckoutCartItem({ cartToken: GUEST_TOKEN }, { categoryId: 200 })
    expect(result).toMatchObject({ code: 400, case: 'categoryLimit', limit: 1 })
  })
})

describe('sales period gate (returns before any claim)', () => {
  it('returns 400 notOnSale when the category has no sales period at all', async () => {
    setupFetch(adminTokenHandler, (url) => { if (url.includes('/product-categories')) return { ...CATEGORY, salesPeriod: [] } })
    expect(await addCheckoutCartItem(null, { categoryId: 200 })).toMatchObject({ code: 400, case: 'notOnSale' })
  })
  it('returns 400 notOnSale when the sales period has passed', async () => {
    const expired = { ...CATEGORY, salesPeriod: [{ startDateTime: '2025-01-01T00:00:00.000Z', endDateTime: '2025-06-01T00:00:00.000Z' }] }
    setupFetch(adminTokenHandler, (url) => { if (url.includes('/product-categories')) return expired })
    expect(await addCheckoutCartItem(null, { categoryId: 200 })).toMatchObject({ code: 400, case: 'notOnSale' })
  })
})
