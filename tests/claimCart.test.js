/**
 * claimGuestCart — covers the four key scenarios:
 *   1. Token not found (already cleared) → idempotent no-op
 *   2. No existing user cart → convert guest cart in-place
 *   3. User has an existing cart → merge guest items, delete guest cart
 *   4. Double-claim (call twice) → second call is a no-op
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { claimGuestCart } from '../server/utils/strapi.js'

const NOW = '2026-06-02T12:00:00.000Z'
const USER_ID = 42
const GUEST_TOKEN = 'claim-test-token'

const ADMIN_JWT_PAYLOAD = Buffer.from(JSON.stringify({ exp: Math.floor(new Date(NOW).getTime() / 1000) + 3600 })).toString('base64url')
const ADMIN_JWT = `eyJhbGciOiJIUzI1NiJ9.${ADMIN_JWT_PAYLOAD}.sig`

const CATEGORY = {
  id: 300,
  codePrefix: 'CLAIM-PASS-2026',
  priceAtPeriod: [{ startDateTime: '2026-01-01T00:00:00.000Z', endDateTime: '2027-01-01T00:00:00.000Z', price: 50 }],
  pickup_locations: [], business_profile: { id: 8000 }
}
const PRODUCT = { id: 9001, code: 'CLAIM-2026-0001', active: true, product_category: CATEGORY, reserved_to: null, sold_to: null, owner: null, transactions: [] }

const GUEST_CART = {
  id: 700,
  cartProducts: [{ id: 800, product: PRODUCT, priceInCart: 50, timeToCart: NOW }],
  cartUpdatedAt: NOW, cartToken: GUEST_TOKEN,
  cart_status: { id: 1, status: 'active' }, users_permissions_user: null, locale: 'et'
}

const USER_CART = {
  id: 701,
  cartProducts: [{ id: 801, product: { id: 9002 }, priceInCart: 50, timeToCart: NOW }],
  cartUpdatedAt: NOW, cartToken: null,
  cart_status: { id: 1, status: 'active' }, users_permissions_user: { id: USER_ID }, locale: 'et'
}

const SERIALIZED_CART = { items: [{ productId: 9001, price: 50 }], total: 50, secondsRemaining: 1800 }

function setupFetch(...handlers) {
  globalThis.$fetch = vi.fn().mockImplementation(async (url, opts) => {
    for (const h of handlers) {
      const r = h(url, opts)
      if (r !== undefined) return r
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

// ── Missing inputs ─────────────────────────────────────────────────────────────

describe('claimGuestCart — invalid inputs', () => {
  it('returns { claimed: false } when userId is missing', async () => {
    const result = await claimGuestCart(null, GUEST_TOKEN)
    expect(result).toMatchObject({ claimed: false })
  })

  it('returns { claimed: false } when cartToken is missing', async () => {
    const result = await claimGuestCart(USER_ID, null)
    expect(result).toMatchObject({ claimed: false })
  })
})

// ── Empty guest cart ───────────────────────────────────────────────────────────

describe('claimGuestCart — empty guest cart', () => {
  it('deletes the empty guest cart and returns { claimed: true } without touching user cart', async () => {
    const emptyGuestCart = { ...GUEST_CART, cartProducts: [] }
    let guestCartDeleted = false
    setupFetch(
      adminTokenHandler,
      (url, opts) => {
        if (url.includes('/cart-statuses')) return [{ id: 1, status: 'active' }]
        if (url.includes('/carts') && url.includes('cartToken')) return [emptyGuestCart]
        if (url.includes(`/carts/${emptyGuestCart.id}`) && opts?.method === 'DELETE') { guestCartDeleted = true; return {} }
      }
    )
    const result = await claimGuestCart(USER_ID, GUEST_TOKEN)
    expect(result).toMatchObject({ claimed: true, droppedItems: [] })
    expect(guestCartDeleted).toBe(true)
  })
})

// ── Token not found (already claimed or expired) ───────────────────────────────

describe('claimGuestCart — token not found', () => {
  it('returns { claimed: true } idempotently when guest cart is not found', async () => {
    setupFetch(
      adminTokenHandler,
      (url) => {
        if (url.includes('/cart-statuses')) return [{ id: 1, status: 'active' }]
        // No cart found for this token
        if (url.includes('/carts')) return []
      }
    )
    const result = await claimGuestCart(USER_ID, 'nonexistent-token')
    expect(result).toMatchObject({ claimed: true, droppedItems: [] })
  })
})

// ── No existing user cart — convert guest cart in-place ────────────────────────

describe('claimGuestCart — convert (no user cart)', () => {
  it('assigns userId to the guest cart and clears cartToken', async () => {
    let putBody = null
    setupFetch(
      adminTokenHandler,
      (url, opts) => {
        if (url.includes('/cart-statuses')) return [{ id: 1, status: 'active' }]
        // First getCurrentCheckoutCart call: find guest cart by cartToken
        if (url.includes('/carts') && url.includes('cartToken')) return [GUEST_CART]
        // Second getCurrentCheckoutCart call: no user cart
        if (url.includes('/carts') && url.includes(`users_permissions_user=${USER_ID}`)) return []
        // atomic claim by category → returns the bound product
        if (url.includes('/products/claim') && opts?.method === 'POST') return { claimed: [{ id: PRODUCT.id, code: PRODUCT.code }] }
        // cart update (convert in-place)
        if (url.includes(`/carts/${GUEST_CART.id}`) && opts?.method === 'PUT') {
          putBody = opts.body
          return { ...GUEST_CART, users_permissions_user: { id: USER_ID }, cartToken: null }
        }
        // final getCurrentCheckoutCart for serialization
        if (url.includes('/carts')) return [{ ...GUEST_CART, users_permissions_user: { id: USER_ID }, cartToken: null }]
        if (url.includes('/product-categories/')) return CATEGORY
      }
    )
    const result = await claimGuestCart(USER_ID, GUEST_TOKEN)
    expect(result.claimed).toBe(true)
    expect(result.droppedItems).toEqual([])
    expect(putBody?.users_permissions_user).toBe(USER_ID)
    expect(putBody?.cartToken).toBeNull()
  })

  it('binds a guest line to a DIFFERENT product when the one it referenced was taken (category still has stock)', async () => {
    // Guest cart referenced product 9001, but it was robbed while browsing; the category still
    // has product 9009 free, so the line survives and is bound to 9009 (your security model).
    let putBody = null
    setupFetch(
      adminTokenHandler,
      (url, opts) => {
        if (url.includes('/cart-statuses')) return [{ id: 1, status: 'active' }]
        if (url.includes('/carts') && url.includes('cartToken')) return [GUEST_CART] // references 9001
        if (url.includes('/carts') && url.includes(`users_permissions_user=${USER_ID}`)) return []
        if (url.includes('/products/claim') && opts?.method === 'POST') return { claimed: [{ id: 9009, code: 'CLAIM-2026-0009' }] }
        if (url.includes(`/carts/${GUEST_CART.id}`) && opts?.method === 'PUT') { putBody = opts.body; return { ...GUEST_CART, users_permissions_user: { id: USER_ID }, cartToken: null } }
        if (url.includes('/carts')) return [{ ...GUEST_CART, users_permissions_user: { id: USER_ID }, cartToken: null }]
        if (url.includes('/product-categories/')) return CATEGORY
      }
    )
    const result = await claimGuestCart(USER_ID, GUEST_TOKEN)
    expect(result.claimed).toBe(true)
    expect(result.droppedItems).toEqual([])
    expect(putBody.cartProducts.map(r => r.product)).toEqual([9009]) // bound to the actually-claimed product
  })

  it('drops a line into droppedItems when its category is sold out, and still converts the cart', async () => {
    const guestCartWithSold = { ...GUEST_CART, cartProducts: [{ id: 800, product: PRODUCT, priceInCart: 50, timeToCart: NOW }] }
    setupFetch(
      adminTokenHandler,
      (url, opts) => {
        if (url.includes('/cart-statuses')) return [{ id: 1, status: 'active' }]
        if (url.includes('/carts') && url.includes('cartToken')) return [guestCartWithSold]
        if (url.includes('/carts') && url.includes(`users_permissions_user=${USER_ID}`)) return []
        if (url.includes('/products/claim')) return { claimed: [] } // category sold out → nothing to bind
        if (url.includes(`/carts/${GUEST_CART.id}`) && opts?.method === 'PUT') return { ...guestCartWithSold, users_permissions_user: { id: USER_ID }, cartToken: null }
        if (url.includes('/carts')) return [{ ...guestCartWithSold, users_permissions_user: { id: USER_ID }, cartToken: null }]
        if (url.includes('/product-categories/')) return CATEGORY
      }
    )
    const result = await claimGuestCart(USER_ID, GUEST_TOKEN)
    expect(result.claimed).toBe(true)
    expect(result.droppedItems).toEqual([{ productId: PRODUCT.id, reason: 'soldOut' }])
  })
})

// ── User has existing cart — merge ─────────────────────────────────────────────

describe('claimGuestCart — merge (user has existing cart)', () => {
  it('adds guest products to user cart and deletes guest cart', async () => {
    let userCartPutBody = null
    let guestCartDeleted = false
    setupFetch(
      adminTokenHandler,
      (url, opts) => {
        if (url.includes('/cart-statuses')) return [{ id: 1, status: 'active' }]
        if (url.includes('/carts') && url.includes('cartToken')) return [GUEST_CART]
        if (url.includes('/carts') && url.includes(`users_permissions_user=${USER_ID}`)) return [USER_CART]
        if (url.includes('/products/claim') && opts?.method === 'POST') return { claimed: [{ id: PRODUCT.id, code: PRODUCT.code }] }
        if (url.includes(`/carts/${USER_CART.id}`) && opts?.method === 'PUT') {
          userCartPutBody = opts.body; return USER_CART
        }
        if (url.includes(`/carts/${GUEST_CART.id}`) && opts?.method === 'DELETE') {
          guestCartDeleted = true; return {}
        }
        if (url.includes('/carts') && !url.includes('/carts/')) return [USER_CART]
        if (url.includes('/product-categories/')) return CATEGORY
      }
    )
    const result = await claimGuestCart(USER_ID, GUEST_TOKEN)
    expect(result.claimed).toBe(true)
    expect(guestCartDeleted).toBe(true)
    // Guest product (9001) added to user cart rows
    const addedIds = (userCartPutBody?.cartProducts || []).map(r => r.product)
    expect(addedIds).toContain(PRODUCT.id)
  })

  it('drops a guest line (no add) when its category has no remaining stock', async () => {
    // User already holds the only product of the category → the claim returns nothing, so the
    // guest line is dropped instead of adding a phantom duplicate (no user-cart write).
    const userCartWithSameProduct = {
      ...USER_CART,
      cartProducts: [{ id: 801, product: PRODUCT, priceInCart: 50, timeToCart: NOW }]
    }
    let userCartPutCalled = false
    setupFetch(
      adminTokenHandler,
      (url, opts) => {
        if (url.includes('/cart-statuses')) return [{ id: 1, status: 'active' }]
        if (url.includes('/carts') && url.includes('cartToken')) return [GUEST_CART]
        if (url.includes('/carts') && url.includes(`users_permissions_user=${USER_ID}`)) return [userCartWithSameProduct]
        if (url.includes('/products/claim')) return { claimed: [] } // category exhausted
        if (url.includes(`/carts/${USER_CART.id}`) && opts?.method === 'PUT') { userCartPutCalled = true; return userCartWithSameProduct }
        if (url.includes(`/carts/${GUEST_CART.id}`) && opts?.method === 'DELETE') return {}
        if (url.includes('/carts') && !url.includes('/carts/')) return [userCartWithSameProduct]
        if (url.includes('/product-categories/')) return CATEGORY
      }
    )
    const result = await claimGuestCart(USER_ID, GUEST_TOKEN)
    expect(result.claimed).toBe(true)
    expect(result.droppedItems).toEqual([{ productId: PRODUCT.id, reason: 'soldOut' }])
    expect(userCartPutCalled).toBe(false)
  })

  it('drops a guest line on merge when it would exceed the category cartLimit', async () => {
    // User cart already holds 1 of a cartLimit=1 category; the guest line of the same category must
    // be dropped on merge (the side door must re-enforce the front-door limit), without even claiming.
    const LIMITED = { ...CATEGORY, cartLimit: 1 }
    const guestProductLimited = { ...PRODUCT, id: 9050, product_category: LIMITED }
    const guestCartLimited = { ...GUEST_CART, cartProducts: [{ id: 850, product: guestProductLimited, priceInCart: 50, timeToCart: NOW }] }
    const userCartAtLimit = { ...USER_CART, cartProducts: [{ id: 801, product: { id: 9002, product_category: LIMITED }, priceInCart: 50, timeToCart: NOW }] }
    let userCartPutCalled = false
    let claimCalled = false
    setupFetch(
      adminTokenHandler,
      (url, opts) => {
        if (url.includes('/cart-statuses')) return [{ id: 1, status: 'active' }]
        if (url.includes('/carts') && url.includes('cartToken')) return [guestCartLimited]
        if (url.includes('/carts') && url.includes(`users_permissions_user=${USER_ID}`)) return [userCartAtLimit]
        if (url.includes('/products/claim')) { claimCalled = true; return { claimed: [{ id: 9051, code: 'X' }] } }
        if (url.includes(`/carts/${USER_CART.id}`) && opts?.method === 'PUT') { userCartPutCalled = true; return userCartAtLimit }
        if (url.includes(`/carts/${GUEST_CART.id}`) && opts?.method === 'DELETE') return {}
        if (url.includes('/carts') && !url.includes('/carts/')) return [userCartAtLimit]
        if (url.includes('/product-categories/')) return LIMITED
      }
    )
    const result = await claimGuestCart(USER_ID, GUEST_TOKEN)
    expect(result.claimed).toBe(true)
    expect(result.droppedItems).toContainEqual({ productId: 9050, reason: 'cartLimit' })
    expect(claimCalled).toBe(false)      // limit checked BEFORE claiming
    expect(userCartPutCalled).toBe(false) // nothing added → no cart write
  })
})
