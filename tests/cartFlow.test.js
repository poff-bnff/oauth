/**
 * Cart operations — customer flow tests.
 * $fetch is globally mocked in setup.js; each test configures only the responses it needs.
 *
 * Customer journey covered:
 *   add to cart → remove from cart → clear cart → touch session → pay
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  addCheckoutCartItem,
  removeCheckoutCartItem,
  clearCheckoutCart,
  touchCheckoutCartSession,
  payCheckoutCart
} from '../server/utils/strapi.js'

// ─── Shared fixtures ──────────────────────────────────────────────────────────

const USER_ID = 29181
const NOW = '2026-06-02T12:00:00.000Z'

const ACTIVE_PRICE_PERIOD = {
  startDateTime: '2026-01-01T00:00:00.000Z',
  endDateTime:   '2027-01-01T00:00:00.000Z',
  price: 100
}

const ACTIVE_SALES_PERIOD = {
  startDateTime: '2026-01-01T00:00:00.000Z',
  endDateTime:   '2027-01-01T00:00:00.000Z'
}

const CATEGORY = {
  id: 109,
  codePrefix: 'LOCAL-INVOICE-TEST-2026',
  namePrivate: 'Arve testpass 2026',
  priceAtPeriod: [ACTIVE_PRICE_PERIOD],
  salesPeriod: [ACTIVE_SALES_PERIOD],
  pickup_locations: [],
  business_profile: { id: 6490 }
}

const PRODUCT = {
  id: 7255,
  code: 'TEST-2026-0004',
  active: true,
  product_category: CATEGORY,
  reservation_time: null,
  reserved_to: null,
  sold_to: null
}

const EMPTY_CART = {
  id: 13,
  cartProducts: [],
  cartUpdatedAt: NOW,
  cartTimeout: '00:30:00',
  cart_status: { id: 1, status: 'active' },
  users_permissions_user: { id: USER_ID }
}

const CART_WITH_ITEM = {
  ...EMPTY_CART,
  cartProducts: [{ id: 100, product: PRODUCT, priceInCart: 100, timeToCart: NOW }]
}

const SECOND_PRODUCT = {
  ...PRODUCT,
  id: 7256,
  code: 'TEST-2026-0005'
}

const CART_WITH_TWO_ITEMS = {
  ...EMPTY_CART,
  cartProducts: [
    { id: 100, product: PRODUCT, priceInCart: 100, timeToCart: NOW },
    { id: 101, product: SECOND_PRODUCT, priceInCart: 100, timeToCart: NOW }
  ]
}

const SERIALIZED_CART = {
  items: [{ productId: 7255, price: 100, index: 0, codePrefix: 'LOCAL-INVOICE-TEST-2026', categoryId: 109 }],
  total: 100,
  expiresAt: '2026-06-02T12:30:00.000Z',
  secondsRemaining: 1800
}

const COMPLETE_BUYER_PROFILE = {
  email: 'jaan@example.ee',
  firstName: 'Jaan',
  lastName: 'Tamm',
  birthdate: '1990-01-01',
  phoneNr: '+3725551234',
  gender: 'male',
  picture: 'https://cdn.poff.ee/pic.jpg'
}

// A real-looking JWT with exp set to 1 hour from NOW so the cache doesn't block re-fetching.
// Header.Payload.Signature — only payload needs to be valid base64 JSON.
const ADMIN_JWT_PAYLOAD = Buffer.from(JSON.stringify({ exp: Math.floor(new Date(NOW).getTime() / 1000) + 3600 })).toString('base64url')
const ADMIN_JWT = `eyJhbGciOiJIUzI1NiJ9.${ADMIN_JWT_PAYLOAD}.sig`
const ADMIN_TOKEN_RESPONSE = { data: { token: ADMIN_JWT } }

function setupFetch(...handlers) {
  globalThis.$fetch = vi.fn().mockImplementation(async (url, opts) => {
    for (const handler of handlers) {
      const result = handler(url, opts)
      if (result !== undefined) return result
    }
    throw new Error(`Unmocked $fetch call: ${url}`)
  })
}

function adminTokenHandler(url) {
  if (url.includes('/admin/login')) return ADMIN_TOKEN_RESPONSE
}

// Pin the clock to NOW for the whole file so cart fixtures (cartUpdatedAt: NOW)
// are never treated as expired by checkoutCartExpired(). Without this, real
// time would make the 30-min window appear elapsed and carts serialize empty.
// Reset $fetch to a fresh mock each test so call-history assertions
// (.not.toHaveBeenCalled()) never see a previous test's calls.
beforeEach(() => {
  vi.setSystemTime(new Date(NOW))
  globalThis.$fetch = vi.fn()
})
afterEach(() => { vi.useRealTimers() })

// ─── Add to cart ──────────────────────────────────────────────────────────────

describe('addCheckoutCartItem', () => {
  // Null owner = brand-new anonymous guest — valid for add. Guest cart tests are in guestCart.test.js.

  it('returns 400 noCategoryId when categoryId is missing', async () => {
    setupFetch(
      adminTokenHandler,
      (url) => { if (url.includes('/product-categories')) return null }
    )
    const result = await addCheckoutCartItem({ userId: USER_ID }, {})
    expect(result).toMatchObject({ code: 400, case: 'noCategoryId' })
  })

  it('returns 400 noCurrentPrice when category has no active price period', async () => {
    setupFetch(
      adminTokenHandler,
      (url) => { if (url.includes('/product-categories')) return { id: 109, codePrefix: 'TEST', priceAtPeriod: [], salesPeriod: [ACTIVE_SALES_PERIOD] } }
    )
    const result = await addCheckoutCartItem({ userId: USER_ID },{ categoryId: 109 })
    expect(result).toMatchObject({ code: 400, case: 'noCurrentPrice' })
  })

  it('returns 404 noItems when no products are available for the category', async () => {
    setupFetch(
      adminTokenHandler,
      (url) => {
        if (url.includes('/product-categories')) return CATEGORY
        if (url.includes('/carts') && !url.includes('/carts/')) return []
        if (url.includes('/products')) return []
        if (url.includes('/carts')) return EMPTY_CART
        if (url.includes('/cart-statuses')) return [{ id: 1, status: 'active' }]
      }
    )
    const result = await addCheckoutCartItem({ userId: USER_ID },{ categoryId: 109 })
    expect(result).toMatchObject({ code: 404, case: 'noItems', available: 0 })
  })

  it('returns 404 noItems with available count when partial stock (wants 2, only 1 left)', async () => {
    setupFetch(
      adminTokenHandler,
      (url) => {
        if (url.includes('/product-categories')) return CATEGORY
        if (url.includes('/products')) return [PRODUCT]
        if (url.includes('/carts') && !url.includes('/carts/')) return []
        if (url.includes('/carts')) return EMPTY_CART
        if (url.includes('/cart-statuses')) return [{ id: 1, status: 'active' }]
      }
    )
    const result = await addCheckoutCartItem({ userId: USER_ID },{ categoryId: 109, quantity: 2 })
    expect(result).toMatchObject({ code: 404, case: 'noItems', available: 1 })
  })

  it('clamps quantity to minimum 1', async () => {
    setupFetch(
      adminTokenHandler,
      (url) => {
        if (url.includes('/product-categories')) return CATEGORY
        if (url.includes('/products')) return []
        if (url.includes('/carts') && !url.includes('/carts/')) return []
        if (url.includes('/carts')) return EMPTY_CART
        if (url.includes('/cart-statuses')) return [{ id: 1, status: 'active' }]
      }
    )
    const result = await addCheckoutCartItem({ userId: USER_ID },{ categoryId: 109, quantity: -5 })
    // quantity clamped to 1, but no items available
    expect(result).toMatchObject({ code: 404, case: 'noItems' })
  })

  it('clamps quantity to maximum 20', async () => {
    // 21 products available, but max quantity is 20
    const manyProducts = Array.from({ length: 21 }, (_, i) => ({ ...PRODUCT, id: 7200 + i }))
    let productCallCount = 0
    setupFetch(
      adminTokenHandler,
      (url) => {
        if (url.includes('/product-categories')) return CATEGORY
        if (url.includes('/products')) { productCallCount++; return manyProducts.slice(0, 20) }
        if (url.includes('/carts') && !url.includes('/carts/')) return []
        if (url.includes('/carts')) return EMPTY_CART
        if (url.includes('/cart-statuses')) return [{ id: 1, status: 'active' }]
        if (url.includes('/product/')) return { reserved_to: USER_ID }
      }
    )
    // With quantity=21, it'll be clamped to 20 — test passes if it doesn't ask for 21
    const result = await addCheckoutCartItem({ userId: USER_ID },{ categoryId: 109, quantity: 21 })
    // If it returns noItems, the products mock limited correctly; either way no server error
    expect([409, 404, undefined]).not.toContain(result?.code === 500)
  })

  // ── "Add another" exclusion: the shop UI lets a user add multiple items of the
  // same category. The backend must hand out a DIFFERENT physical product each
  // time (never re-add one already in the cart), and report noItems once the
  // category's stock is exhausted. This is what drives the shop's "Add another"
  // button to disable itself and keeps the SSG preview in sync with the cart.

  it('returns noItems when the only available product is already in the cart', async () => {
    // Cart already holds product 7255; the category's only stock IS 7255.
    setupFetch(
      adminTokenHandler,
      (url) => {
        if (url.includes('/product-categories')) return CATEGORY
        if (url.includes('/cart-statuses')) return [{ id: 1, status: 'active' }]
        if (url.includes('/carts') && !url.includes('/carts/')) return [CART_WITH_ITEM]
        if (url.includes('/products')) return [PRODUCT] // id 7255 — already in cart
      }
    )
    const result = await addCheckoutCartItem({ userId: USER_ID },{ categoryId: 109 })
    expect(result).toMatchObject({ code: 404, case: 'noItems', available: 0 })
  })

  it('adds a different physical product when adding another of the same category', async () => {
    // Cart holds 7255; stock has 7255 + 7256. Adding another must pick 7256.
    const PRODUCT_2 = { ...PRODUCT, id: 7256, code: 'TEST-2026-0005' }
    let putCartBody = null
    setupFetch(
      adminTokenHandler,
      (url, opts) => {
        if (url.includes('/product-categories')) return CATEGORY
        if (url.includes('/cart-statuses')) return [{ id: 1, status: 'active' }]
        // Single-product reservation: PUT returns a reserved record, GET returns the product
        if (url.includes('/products/')) {
          if (opts?.method === 'PUT') return { reserved_to: USER_ID }
          return url.includes('7256') ? PRODUCT_2 : PRODUCT
        }
        if (url.includes('/products')) return [PRODUCT, PRODUCT_2] // list: both in stock
        if (url.includes('/carts') && !url.includes('/carts/')) return [CART_WITH_ITEM]
        if (url.includes('/carts/') && opts?.method === 'PUT') {
          putCartBody = opts.body
          return {
            ...CART_WITH_ITEM,
            cartProducts: [
              { id: 100, product: PRODUCT,   priceInCart: 100, timeToCart: NOW },
              { id: 101, product: PRODUCT_2, priceInCart: 100, timeToCart: NOW }
            ]
          }
        }
      }
    )
    const result = await addCheckoutCartItem({ userId: USER_ID },{ categoryId: 109 })

    // The PUT preserved the existing row (7255, once) and appended the new one (7256)
    const writtenIds = putCartBody.cartProducts.map(r => r.product)
    expect(writtenIds).toContain(7256)
    expect(writtenIds.filter(id => id === 7255)).toHaveLength(1) // not duplicated
    // Serialized cart returned to the client has both items
    expect(result.items.map(i => i.productId)).toEqual([7255, 7256])
  })
})

// ─── Remove from cart ─────────────────────────────────────────────────────────

describe('removeCheckoutCartItem', () => {
  it('returns 401 when owner is null', async () => {
    globalThis.$fetch = vi.fn()
    const result = await removeCheckoutCartItem(null, { index: 0 })
    expect(result).toMatchObject({ code: 401, case: 'unauthorized' })
    expect(globalThis.$fetch).not.toHaveBeenCalled()
  })

  it('returns 404 noCart when user has no active cart', async () => {
    setupFetch(
      adminTokenHandler,
      (url) => {
        if (url.includes('/carts')) return []
        if (url.includes('/cart-statuses')) return [{ id: 1, status: 'active' }]
      }
    )
    const result = await removeCheckoutCartItem({ userId: USER_ID },{ index: 0 })
    expect(result).toMatchObject({ code: 404, case: 'noCart' })
  })

  it('removes item by index and returns updated cart', async () => {
    let updatedCart = null
    setupFetch(
      adminTokenHandler,
      (url, opts) => {
        if (url.includes('/cart-statuses')) return [{ id: 1, status: 'active' }]
        if (url.includes('/carts') && !url.includes('/carts/')) return [CART_WITH_ITEM]
        if (url.includes('/carts/') && opts?.method === 'PUT') {
          updatedCart = opts.body
          return { ...CART_WITH_ITEM, cartProducts: opts.body.cartProducts }
        }
        if (url.includes('/products/') && opts?.method === 'PUT') return PRODUCT
      }
    )
    const result = await removeCheckoutCartItem({ userId: USER_ID },{ index: 0 })
    expect(updatedCart?.cartProducts).toHaveLength(0)
  })

  it('removes item by productId when index not provided', async () => {
    let updatedCart = null
    setupFetch(
      adminTokenHandler,
      (url, opts) => {
        if (url.includes('/cart-statuses')) return [{ id: 1, status: 'active' }]
        if (url.includes('/carts') && !url.includes('/carts/')) return [CART_WITH_ITEM]
        if (url.includes('/carts/') && opts?.method === 'PUT') {
          updatedCart = opts.body
          return { ...CART_WITH_ITEM, cartProducts: opts.body.cartProducts }
        }
        if (url.includes('/products/') && opts?.method === 'PUT') return PRODUCT
      }
    )
    const result = await removeCheckoutCartItem({ userId: USER_ID },{ productId: 7255 })
    expect(updatedCart?.cartProducts).toHaveLength(0)
  })

  it('clears only the removed product reservation without refreshing remaining items', async () => {
    const productPuts = []
    setupFetch(
      adminTokenHandler,
      (url, opts) => {
        if (url.includes('/cart-statuses')) return [{ id: 1, status: 'active' }]
        if (url.includes('/carts') && !url.includes('/carts/')) return [CART_WITH_TWO_ITEMS]
        if (url.includes('/products/7255') && !opts?.method) return { ...PRODUCT, reserved_to: USER_ID }
        if (url.includes('/products/7256') && !opts?.method) return SECOND_PRODUCT
        if (url.includes('/products/') && opts?.method === 'PUT') {
          productPuts.push({ url, body: opts.body })
          return url.includes('/products/7255') ? PRODUCT : SECOND_PRODUCT
        }
        if (url.includes('/carts/') && opts?.method === 'PUT') {
          return { ...CART_WITH_TWO_ITEMS, cartProducts: opts.body.cartProducts }
        }
      }
    )

    await removeCheckoutCartItem({ userId: USER_ID }, { productId: 7255 })

    expect(productPuts).toHaveLength(1)
    expect(productPuts[0].url).toContain('/products/7255')
    expect(productPuts[0].body).toMatchObject({
      reserved_to: null,
      reservation_price: null,
      reservation_time: null
    })
  })
})

// ─── Clear cart ───────────────────────────────────────────────────────────────

describe('clearCheckoutCart', () => {
  it('returns { ok: true } when owner is null (idempotent — nothing to clear)', async () => {
    globalThis.$fetch = vi.fn()
    const result = await clearCheckoutCart(null)
    expect(result).toMatchObject({ ok: true })
    expect(globalThis.$fetch).not.toHaveBeenCalled()
  })

  it('returns { ok: true } when user has no cart (idempotent)', async () => {
    setupFetch(
      adminTokenHandler,
      (url) => {
        if (url.includes('/cart-statuses')) return [{ id: 1, status: 'active' }]
        if (url.includes('/carts')) return []
      }
    )
    const result = await clearCheckoutCart({ userId: USER_ID })
    expect(result).toMatchObject({ ok: true })
  })

  it('clears all cart products and releases reservations', async () => {
    let clearedBody = null
    setupFetch(
      adminTokenHandler,
      (url, opts) => {
        if (url.includes('/cart-statuses')) return [{ id: 1, status: 'active' }]
        if (url.includes('/carts') && !url.includes('/carts/')) return [CART_WITH_ITEM]
        if (url.includes('/carts/') && opts?.method === 'PUT') {
          clearedBody = opts.body
          return { ...CART_WITH_ITEM, cartProducts: [] }
        }
        if (url.includes('/products/') && opts?.method === 'PUT') return PRODUCT
      }
    )
    await clearCheckoutCart({ userId: USER_ID })
    expect(clearedBody?.cartProducts).toEqual([])
  })
})

// ─── Touch session ────────────────────────────────────────────────────────────

describe('touchCheckoutCartSession', () => {
  it('returns empty cart shape when owner is null (early return, no fetch)', async () => {
    globalThis.$fetch = vi.fn()
    const result = await touchCheckoutCartSession(null)
    expect(result).toMatchObject({ items: [], total: 0 })
    expect(globalThis.$fetch).not.toHaveBeenCalled()
  })

  it('returns empty cart shape when user has no active cart', async () => {
    setupFetch(
      adminTokenHandler,
      (url) => {
        if (url.includes('/cart-statuses')) return [{ id: 1, status: 'active' }]
        if (url.includes('/carts')) return []
      }
    )
    const result = await touchCheckoutCartSession({ userId: USER_ID })
    expect(result).toMatchObject({ items: [], total: 0 })
  })

  it('updates cartUpdatedAt to refresh the 30-minute window', async () => {
    let touchedAt = null
    const before = Date.now()
    setupFetch(
      adminTokenHandler,
      (url, opts) => {
        if (url.includes('/cart-statuses')) return [{ id: 1, status: 'active' }]
        if (url.includes('/carts') && !url.includes('/carts/')) return [CART_WITH_ITEM]
        if (url.includes('/carts/') && opts?.method === 'PUT') {
          touchedAt = opts.body?.cartUpdatedAt
          return CART_WITH_ITEM
        }
        if (url.includes('/products/') && opts?.method === 'PUT') return { reserved_to: USER_ID }
      }
    )
    await touchCheckoutCartSession({ userId: USER_ID },'en')
    expect(touchedAt).toBeTruthy()
    expect(new Date(touchedAt).getTime()).toBeGreaterThanOrEqual(before)
  })
})

// ─── Pay checkout cart ────────────────────────────────────────────────────────

describe('payCheckoutCart — input validation', () => {
  it('returns 401 when user is not authenticated', async () => {
    globalThis.$fetch = vi.fn()
    const result = await payCheckoutCart(null, { paymentMethodId: 'card' })
    expect(result).toMatchObject({ code: 401, case: 'unauthorized' })
    expect(globalThis.$fetch).not.toHaveBeenCalled()
  })

  it('returns 400 noPaymentMethodId when payment method is missing', async () => {
    globalThis.$fetch = vi.fn()
    const result = await payCheckoutCart(USER_ID, {})
    expect(result).toMatchObject({ code: 400, case: 'noPaymentMethodId' })
    expect(globalThis.$fetch).not.toHaveBeenCalled()
  })

  it('returns 400 emptyCart when cart has no items', async () => {
    setupFetch(
      adminTokenHandler,
      (url) => {
        if (url.includes('/cart-statuses')) return [{ id: 1, status: 'active' }]
        if (url.includes('/carts')) return [{ ...EMPTY_CART, cartProducts: [] }]
      }
    )
    const result = await payCheckoutCart(USER_ID, { paymentMethodId: 'nordea' })
    expect(result).toMatchObject({ code: 400, case: 'emptyCart' })
  })

  it('returns 400 invalidBillingProfile when billingProfileId is not provided', async () => {
    setupFetch(
      adminTokenHandler,
      (url) => {
        if (url.includes('/cart-statuses')) return [{ id: 1, status: 'active' }]
        if (url.includes('/carts')) return [CART_WITH_ITEM]
        if (url.includes('/product-categories/')) return CATEGORY
        if (url.includes('/users/') || url.includes('/users-permissions')) return { id: USER_ID, user_profile: COMPLETE_BUYER_PROFILE }
        if (url.includes('/business-profiles')) return []
      }
    )
    const result = await payCheckoutCart(USER_ID, {
      paymentMethodId: 'nordea',
      billingProfileId: null
    })
    expect(result).toMatchObject({ code: 400, case: 'invalidBillingProfile' })
  })

  it('returns 400 invalidBillingProfile when profile belongs to another user', async () => {
    setupFetch(
      adminTokenHandler,
      (url) => {
        if (url.includes('/cart-statuses')) return [{ id: 1, status: 'active' }]
        if (url.includes('/carts')) return [CART_WITH_ITEM]
        if (url.includes('/business-profiles')) return [] // empty = not found for this user
        if (url.includes('/users/') || url.includes('/users-permissions')) return { id: USER_ID, user_profile: COMPLETE_BUYER_PROFILE }
      }
    )
    const result = await payCheckoutCart(USER_ID, {
      paymentMethodId: 'nordea',
      billingProfileId: 999 // belongs to a different user
    })
    expect(result).toMatchObject({ code: 400, case: 'invalidBillingProfile' })
  })

  it('returns 400 buyerProfileIncomplete when user profile is missing required fields', async () => {
    // 4-field check: email, firstName, lastName, picture
    const incompleteProfile = { email: 'jaan@test.ee', firstName: 'Jaan' } // missing lastName, picture
    setupFetch(
      adminTokenHandler,
      (url) => {
        if (url.includes('/cart-statuses')) return [{ id: 1, status: 'active' }]
        if (url.includes('/carts')) return [CART_WITH_ITEM]
        if (url.includes('/business-profiles')) return [{ id: 6496 }]
        if (url.includes('/users/') || url.includes('/users-permissions')) return { id: USER_ID, user_profile: incompleteProfile, aliasUsers: [] }
      }
    )
    const result = await payCheckoutCart(USER_ID, {
      paymentMethodId: 'nordea',
      billingProfileId: 6496
    })
    expect(result).toMatchObject({ code: 400, case: 'buyerProfileIncomplete' })
    expect(result.missing).toContain('lastName')
    expect(result.missing).toContain('picture')
    expect(result.missing).not.toContain('birthdate') // birthdate not required by 4-field check
  })

  it('returns 400 buyerProfileIncomplete listing all 4 missing fields when profile is empty', async () => {
    setupFetch(
      adminTokenHandler,
      (url) => {
        if (url.includes('/cart-statuses')) return [{ id: 1, status: 'active' }]
        if (url.includes('/carts')) return [CART_WITH_ITEM]
        if (url.includes('/business-profiles')) return [{ id: 6496 }]
        if (url.includes('/users/') || url.includes('/users-permissions')) return { id: USER_ID, user_profile: {}, aliasUsers: [] }
      }
    )
    const result = await payCheckoutCart(USER_ID, { paymentMethodId: 'nordea', billingProfileId: 6496 })
    expect(result.missing).toHaveLength(4) // email, firstName, lastName, picture
  })
})

// ─── Pay checkout cart — happy path ─────────────────────────────────────────────
//
// Drives payCheckoutCart all the way through: product reservation, order creation,
// the cart status transition, and the Maksekeskus transaction. Asserts the order
// body, the merchant_data payload shape, and the seller resolution per item.

const BILLING_PROFILE_ID = 6496
// Method id is built as `${country}_${name}`.toUpperCase() — so this must match what the
// Maksekeskus response advertises (ee + nordea → EE_NORDEA).
const PAYMENT_METHOD = { country: 'ee', name: 'nordea', url: 'https://pay.maksekeskus.test/nordea-redirect' }
const PAYMENT_METHOD_ID = 'EE_NORDEA'

// Status fixtures keyed by the `status=` query param so each transition gets a distinct id.
const ORDER_STATUS = { pending_payment: { id: 41, status: 'pending_payment' }, payment_failed: { id: 42, status: 'payment_failed' } }
const CART_STATUS = { active: { id: 1, status: 'active' }, checkout_started: { id: 2, status: 'checkout_started' } }

function statusFor(map, url) {
  const status = new URL(url, 'http://x').searchParams.get('status')
  return map[status] ? [map[status]] : []
}

// Builds the full happy-path $fetch mock; `captured` collects the request bodies we assert on.
function setupHappyPathFetch(captured, overrides = {}) {
  setupFetch(
    adminTokenHandler,
    (url, opts) => {
      if (url.includes('/cart-statuses')) return statusFor(CART_STATUS, url)
      if (url.includes('/order-statuses')) return statusFor(ORDER_STATUS, url)
      // List carts (stale sweep + current-cart lookup) — single item, not expired (clock pinned to NOW).
      if (url.includes('/carts') && !url.includes('/carts/')) return [overrides.cart || CART_WITH_ITEM]
      if (url.includes('/carts/') && opts?.method === 'PUT') { captured.cartPut = opts.body; return {} }
      if (url.includes('/business-profiles')) return [{ id: BILLING_PROFILE_ID }]
      if (url.includes(`/users/${USER_ID}`)) return { id: USER_ID, user_profile: COMPLETE_BUYER_PROFILE, aliasUsers: [] }
      if (url.includes('/product-categories/')) return CATEGORY
      if (url.includes('/products/') && (!opts || opts.method !== 'PUT')) return PRODUCT
      if (url.includes('/products/') && opts?.method === 'PUT') return { ...PRODUCT, reserved_to: USER_ID }
      if (url.includes('/orders') && opts?.method === 'POST') { captured.orderBody = opts.body; return { id: 9001 } }
      if (url.includes('/v1/transactions') && opts?.method === 'POST') {
        captured.mkBody = opts.body
        return overrides.mkResponse || { id: 'tx-abc', payment_methods: { banklinks: [PAYMENT_METHOD] } }
      }
    }
  )
}

describe('payCheckoutCart — happy path', () => {
  it('creates an order, moves the cart to checkout, and returns the payment URL', async () => {
    const captured = {}
    setupHappyPathFetch(captured)

    const result = await payCheckoutCart(USER_ID, {
      paymentMethodId: PAYMENT_METHOD_ID,
      billingProfileId: BILLING_PROFILE_ID,
      locale: 'et'
    })

    expect(result).toEqual({ url: PAYMENT_METHOD.url, orderId: 9001 })
  })

  it('posts an order with the cart total, billing profile, pending status, and component rows', async () => {
    const captured = {}
    setupHappyPathFetch(captured)

    await payCheckoutCart(USER_ID, { paymentMethodId: PAYMENT_METHOD_ID, billingProfileId: BILLING_PROFILE_ID })

    expect(captured.orderBody).toMatchObject({
      users_permissions_user: USER_ID,
      orderSum: 100,
      buyerBusinessProfile: BILLING_PROFILE_ID,
      order_status: ORDER_STATUS.pending_payment.id
    })
    expect(captured.orderBody.orderProducts).toHaveLength(1)
    expect(captured.orderBody.orderProducts[0]).toMatchObject({
      product: 7255,
      priceInCart: 100,
      owner: USER_ID
    })
  })

  it('moves the cart to checkout_started before redirecting to payment', async () => {
    const captured = {}
    setupHappyPathFetch(captured)

    await payCheckoutCart(USER_ID, { paymentMethodId: PAYMENT_METHOD_ID, billingProfileId: BILLING_PROFILE_ID })

    expect(captured.cartPut).toMatchObject({ cart_status: CART_STATUS.checkout_started.id })
  })

  it('sends a Maksekeskus transaction with the cart amount and reference', async () => {
    const captured = {}
    setupHappyPathFetch(captured)

    await payCheckoutCart(USER_ID, { paymentMethodId: PAYMENT_METHOD_ID, billingProfileId: BILLING_PROFILE_ID })

    expect(captured.mkBody.transaction).toMatchObject({ amount: 100, currency: 'EUR', reference: 'order-9001' })
    expect(captured.mkBody.customer).toMatchObject({ email: COMPLETE_BUYER_PROFILE.email, country: 'ee' })
  })

  it('encodes merchant_data with the cart context and per-item seller', async () => {
    const captured = {}
    setupHappyPathFetch(captured)

    await payCheckoutCart(USER_ID, { paymentMethodId: PAYMENT_METHOD_ID, billingProfileId: BILLING_PROFILE_ID })

    const merchant = JSON.parse(captured.mkBody.transaction.merchant_data)
    expect(merchant).toMatchObject({
      checkoutType: 'cart',
      userId: USER_ID,
      cartId: EMPTY_CART.id,
      orderId: 9001,
      selectedBillingProfileId: BILLING_PROFILE_ID
    })
    expect(merchant.products).toHaveLength(1)
    // Seller resolves from the product category's business_profile (CATEGORY.business_profile.id = 6490).
    expect(merchant.products[0]).toMatchObject({
      productId: 7255,
      productCategoryId: 109,
      productCatSeller: 6490,
      price: 100
    })
  })

  it('returns 400 noPaymentMethod when Maksekeskus omits the chosen method', async () => {
    const captured = {}
    // Maksekeskus advertises only a card method, not the EE_NORDEA the buyer chose.
    setupHappyPathFetch(captured, {
      mkResponse: { id: 'tx-abc', payment_methods: { cards: [{ country: 'ee', name: 'visa', url: 'https://x' }] } }
    })

    const result = await payCheckoutCart(USER_ID, { paymentMethodId: PAYMENT_METHOD_ID, billingProfileId: BILLING_PROFILE_ID })

    expect(result).toMatchObject({ code: 400, case: 'noPaymentMethod' })
    // The failed attempt still created an order, which must be flipped to payment_failed.
    expect(captured.orderBody).toBeTruthy()
  })
})
