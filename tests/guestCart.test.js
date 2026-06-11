/**
 * Guest cart tests — exercises the anonymous (no JWT) add-to-cart path.
 * Key invariants:
 *   - null owner (brand-new guest) → creates cart, returns newCartToken
 *   - { cartToken } owner → appends to existing cart, no newCartToken on second add
 *   - Guests do NOT trigger product reservations (no PUT to /products)
 *   - Cart is capped at CART_LIMITS.maxItemsPerCart (50) items
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { addCheckoutCartItem } from '../server/utils/strapi.js'

const NOW = '2026-06-02T12:00:00.000Z'
const GUEST_TOKEN = 'guest-abc123'

const ACTIVE_PRICE_PERIOD = {
  startDateTime: '2026-01-01T00:00:00.000Z',
  endDateTime:   '2027-01-01T00:00:00.000Z',
  price: 75
}
const CATEGORY = {
  id: 200,
  codePrefix: 'GUEST-PASS-2026',
  namePrivate: 'Guest pass 2026',
  priceAtPeriod: [ACTIVE_PRICE_PERIOD],
  pickup_locations: [],
  business_profile: { id: 7000 }
}
const PRODUCT_A = { id: 8001, code: 'GUEST-2026-0001', active: true, product_category: CATEGORY, reserved_to: null, sold_to: null }
const PRODUCT_B = { id: 8002, code: 'GUEST-2026-0002', active: true, product_category: CATEGORY, reserved_to: null, sold_to: null }

const ADMIN_JWT_PAYLOAD = Buffer.from(JSON.stringify({ exp: Math.floor(new Date(NOW).getTime() / 1000) + 3600 })).toString('base64url')
const ADMIN_JWT = `eyJhbGciOiJIUzI1NiJ9.${ADMIN_JWT_PAYLOAD}.sig`

function setupFetch(...handlers) {
  globalThis.$fetch = vi.fn().mockImplementation(async (url, opts) => {
    for (const h of handlers) {
      const result = h(url, opts)
      if (result !== undefined) return result
    }
    throw new Error(`Unmocked $fetch call: ${url}`)
  })
}

function adminTokenHandler(url) {
  if (url.includes('/admin/login')) return { data: { token: ADMIN_JWT } }
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
      id: 500,
      cartProducts: [{ id: 900, product: PRODUCT_A, priceInCart: 75, timeToCart: NOW }],
      cartUpdatedAt: NOW,
      cartTimeout: null,
      cartToken: GUEST_TOKEN,
      cart_status: { id: 1, status: 'active' },
      users_permissions_user: null,
      locale: 'et'
    }
    const emptyCart = { ...cartWithProduct, cartProducts: [] }
    setupFetch(
      adminTokenHandler,
      (url, opts) => {
        if (url.includes('/product-categories')) return CATEGORY
        if (url.includes('/cart-statuses')) return [{ id: 1, status: 'active' }]
        if (url.includes('/products') && !url.includes('/products/')) return [PRODUCT_A]
        // guest cart creation POST — must return empty cart so existingProductIds stays []
        if (url.includes('/carts') && opts?.method === 'POST') return emptyCart
        // cart item add PUT — returns cart with product after update
        if (url.includes('/carts/') && opts?.method === 'PUT') return cartWithProduct
      }
    )
    const result = await addCheckoutCartItem(null, { categoryId: 200 })
    expect(result.newCartToken).toBeTruthy()
  })

  it('does NOT call the products reservation endpoint for guests', async () => {
    const cartWithProduct = {
      id: 501,
      cartProducts: [{ id: 901, product: PRODUCT_A, priceInCart: 75, timeToCart: NOW }],
      cartUpdatedAt: NOW, cartToken: GUEST_TOKEN,
      cart_status: { id: 1, status: 'active' }, users_permissions_user: null, locale: 'et'
    }
    const emptyCart = { ...cartWithProduct, cartProducts: [] }
    let productPutCalled = false
    setupFetch(
      adminTokenHandler,
      (url, opts) => {
        if (url.includes('/product-categories')) return CATEGORY
        if (url.includes('/cart-statuses')) return [{ id: 1, status: 'active' }]
        if (url.includes('/products') && !url.includes('/products/')) return [PRODUCT_A]
        if (url.includes('/products/') && opts?.method === 'PUT') { productPutCalled = true; return PRODUCT_A }
        if (url.includes('/carts') && opts?.method === 'POST') return emptyCart
        if (url.includes('/carts/') && opts?.method === 'PUT') return cartWithProduct
      }
    )
    await addCheckoutCartItem(null, { categoryId: 200 })
    expect(productPutCalled).toBe(false)
  })

  it('returns 404 noItems when no products are available (guest)', async () => {
    setupFetch(
      adminTokenHandler,
      (url, opts) => {
        if (url.includes('/product-categories')) return CATEGORY
        if (url.includes('/cart-statuses')) return [{ id: 1, status: 'active' }]
        if (url.includes('/products') && !url.includes('/products/')) return []
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
    id: 503,
    cartProducts: [{ id: 902, product: PRODUCT_A, priceInCart: 75, timeToCart: NOW }],
    cartUpdatedAt: NOW, cartToken: GUEST_TOKEN,
    cart_status: { id: 1, status: 'active' }, users_permissions_user: null, locale: 'et'
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
      (url, opts) => {
        if (url.includes('/product-categories')) return CATEGORY
        if (url.includes('/cart-statuses')) return [{ id: 1, status: 'active' }]
        if (url.includes('/carts') && !url.includes('/carts/')) return [existingCart]
        if (url.includes('/products') && !url.includes('/products/')) return [PRODUCT_B]
        if (url.includes('/carts/') && opts?.method === 'PUT') return afterAdd
      }
    )
    const result = await addCheckoutCartItem({ cartToken: GUEST_TOKEN }, { categoryId: 200 })
    expect(result.newCartToken).toBeUndefined()
    expect(result.items).toHaveLength(2)
  })
})

// ── maxItemsPerCart cap ─────────────────────────────────────────────────────────

describe('guest cart item cap', () => {
  it('returns 400 cartFull when cart is already at maxItemsPerCart', async () => {
    const fullProducts = Array.from({ length: 50 }, (_, i) => ({
      id: 9000 + i, product: { id: 8000 + i }, priceInCart: 75, timeToCart: NOW
    }))
    const fullCart = {
      id: 600, cartProducts: fullProducts, cartUpdatedAt: NOW,
      cartToken: GUEST_TOKEN, cart_status: { id: 1, status: 'active' }, users_permissions_user: null
    }
    setupFetch(
      adminTokenHandler,
      (url) => {
        if (url.includes('/product-categories')) return CATEGORY
        if (url.includes('/cart-statuses')) return [{ id: 1, status: 'active' }]
        if (url.includes('/carts') && !url.includes('/carts/')) return [fullCart]
        if (url.includes('/products') && !url.includes('/products/')) return [PRODUCT_A]
      }
    )
    const result = await addCheckoutCartItem({ cartToken: GUEST_TOKEN }, { categoryId: 200 })
    expect(result).toMatchObject({ code: 400, case: 'cartFull' })
  })
})
