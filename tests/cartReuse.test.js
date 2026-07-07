import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { addCheckoutCartItem } from '../server/utils/strapi.js'

const NOW = '2026-06-02T12:00:00.000Z'
const USER_ID = 14783
const GUEST_TOKEN = 'guestToken_1234567890'
const PERIOD = { startDateTime: '2026-01-01T00:00:00.000Z', endDateTime: '2027-01-01T00:00:00.000Z' }
const CATEGORY = { id: 59, codePrefix: 'HOFF-MERCH', priceAtPeriod: [{ ...PERIOD, price: 100 }], salesPeriod: [PERIOD] }

const b64url = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url')
const ADMIN_TOKEN_RESPONSE = { data: { token: `${b64url({ alg: 'HS256', typ: 'JWT' })}.${b64url({ exp: Math.floor(new Date(NOW).getTime() / 1000) + 3600 })}.sig` } }

const STALE_CART = {
  id: 77,
  cartProducts: [],
  cart_status: { id: 4, status: 'checkout_started' },
  users_permissions_user: { id: USER_ID },
  cartUpdatedAt: NOW,
  cartTimeout: '00:30:00'
}

const STALE_GUEST_CART = {
  ...STALE_CART,
  id: 88,
  users_permissions_user: null,
  cartToken: GUEST_TOKEN
}

let postCartsCalled
let putCartIds

function setup() {
  postCartsCalled = false
  putCartIds = []
  globalThis.$fetch = vi.fn().mockImplementation(async (url, opts = {}) => {
    if (url.includes('/admin/login')) return ADMIN_TOKEN_RESPONSE
    if (url.includes('/cart-statuses')) return [{ id: 1, status: 'active' }]
    if (url.includes('/product-categories')) return CATEGORY
    if (url.includes('/products/claim')) return { mode: 'byCategory', got: 1, claimed: [{ id: 9001, code: 'HOFF-1' }] }
    if (url.includes('/carts') && !url.match(/\/carts\/\d+/) && opts.method === 'POST') {
      postCartsCalled = true
      return { id: 999, cartProducts: [], cart_status: { id: 1, status: 'active' } }
    }
    if (url.includes('/carts') && !url.match(/\/carts\/\d+/) && opts.method !== 'POST') {
      return url.includes('cart_status') ? [] : [STALE_CART]
    }
    const put = url.match(/\/carts\/(\d+)/)
    if (put && opts.method === 'PUT') {
      putCartIds.push(Number(put[1]))
      return { ...STALE_CART, cart_status: { id: 1, status: 'active' }, cartProducts: opts.body.cartProducts || [] }
    }
    if (url.includes('/products')) return []
    throw new Error(`Unmocked $fetch call: ${url}`)
  })
}

beforeEach(() => { vi.setSystemTime(new Date(NOW)); globalThis.$fetch = vi.fn() })
afterEach(() => { vi.useRealTimers() })

describe('addCheckoutCartItem — one-to-one cart reuse (no second-cart 500)', () => {
  it('reuses the user\'s existing non-active cart instead of creating a new one', async () => {
    setup()
    const result = await addCheckoutCartItem({ userId: USER_ID }, { categoryId: 59, response: 'minimal' })

    expect(result?.code).toBeUndefined()
    expect(postCartsCalled).toBe(false)
    expect(putCartIds).toContain(77)
  })

  it('does NOT release the reused cart\'s product holds (in-flight payment safety)', async () => {
    const HELD_CART = {
      id: 78,
      cartProducts: [{ id: 5, product: { id: 9009 }, priceInCart: 100, timeToCart: NOW }],
      cart_status: { id: 4, status: 'checkout_started' },
      users_permissions_user: { id: USER_ID },
      cartUpdatedAt: NOW, cartTimeout: '00:30:00'
    }
    let productReleased = false
    globalThis.$fetch = vi.fn().mockImplementation(async (url, opts = {}) => {
      if (url.includes('/admin/login')) return ADMIN_TOKEN_RESPONSE
      if (url.includes('/cart-statuses')) return [{ id: 1, status: 'active' }]
      if (url.includes('/product-categories')) return CATEGORY
      if (url.includes('/products/claim')) return { mode: 'byCategory', got: 1, claimed: [{ id: 9001, code: 'HOFF-1' }] }
      if (url.match(/\/products\/\d+/) && opts.method === 'PUT') { productReleased = true; return {} } // a release
      if (url.match(/\/products\/\d+/)) return { id: 9009, reserved_to: { id: USER_ID } }
      if (url.includes('/carts') && !url.match(/\/carts\/\d+/) && opts.method === 'POST') return { id: 999 }
      if (url.includes('/carts') && !url.match(/\/carts\/\d+/)) return url.includes('cart_status') ? [] : [HELD_CART]
      const put = url.match(/\/carts\/(\d+)/)
      if (put && opts.method === 'PUT') return { ...HELD_CART, cart_status: { id: 1, status: 'active' }, cartProducts: opts.body.cartProducts || [] }
      if (url.includes('/products')) return []
      throw new Error(`Unmocked $fetch call: ${url}`)
    })
    await addCheckoutCartItem({ userId: USER_ID }, { categoryId: 59, response: 'minimal' })
    expect(productReleased).toBe(false)
  })

  it('recovers from a concurrent-create race: create 500s (unique constraint), reuse the winner\'s cart', async () => {
    // Simulates two near-simultaneous first-adds for a user with no cart, on a deploy where Strapi has a
    // unique constraint on carts.users_permissions_user. Our lookups find nothing, the other request wins
    // the create, and our POST /carts is rejected with a duplicate-key 500. We must NOT surface the 500 —
    // we re-fetch and add to the winner's cart instead.
    const WINNER_CART = {
      id: 555, cartProducts: [], cart_status: { id: 1, status: 'active' },
      users_permissions_user: { id: USER_ID }, cartUpdatedAt: NOW, cartTimeout: '00:30:00'
    }
    let postAttempted = false
    const putIds = []
    globalThis.$fetch = vi.fn().mockImplementation(async (url, opts = {}) => {
      if (url.includes('/admin/login')) return ADMIN_TOKEN_RESPONSE
      if (url.includes('/cart-statuses')) return [{ id: 1, status: 'active' }]
      if (url.includes('/product-categories')) return CATEGORY
      if (url.includes('/products/claim')) return { mode: 'byCategory', got: 1, claimed: [{ id: 9001, code: 'HOFF-1' }] }
      // POST /carts — the winner already created the cart, so the unique constraint rejects ours (500).
      if (url.includes('/carts') && !url.match(/\/carts\/\d+/) && opts.method === 'POST') {
        postAttempted = true
        const err = new Error('Duplicate entry'); err.statusCode = 500; throw err
      }
      // GET /carts list: before our POST nothing exists; after it, the active lookup finds the winner.
      if (url.includes('/carts') && !url.match(/\/carts\/\d+/) && opts.method !== 'POST') {
        if (url.includes('cart_status')) return postAttempted ? [WINNER_CART] : []
        return [] // getUserCartAnyStatus — no pre-race cart
      }
      const put = url.match(/\/carts\/(\d+)/)
      if (put && opts.method === 'PUT') { putIds.push(Number(put[1])); return { ...WINNER_CART, cartProducts: opts.body.cartProducts || [] } }
      if (url.includes('/products')) return []
      throw new Error(`Unmocked $fetch call: ${url}`)
    })

    const result = await addCheckoutCartItem({ userId: USER_ID }, { categoryId: 59, response: 'minimal' })

    expect(result?.code).toBeUndefined()   // no 500 surfaced to the client
    expect(postAttempted).toBe(true)        // we did attempt the create and lost the race
    expect(putIds).toContain(555)           // and added the item to the winner's recovered cart
    expect(result.cartId).toBe(555)
    expect(result.itemCount).toBe(1)        // add ends with exactly the one product, not an empty cart
  })

  it('reuses a guest token existing non-active cart instead of creating a duplicate token cart', async () => {
    let claimedToken = null
    globalThis.$fetch = vi.fn().mockImplementation(async (url, opts = {}) => {
      if (url.includes('/admin/login')) return ADMIN_TOKEN_RESPONSE
      if (url.includes('/cart-statuses')) return [{ id: 1, status: 'active' }]
      if (url.includes('/product-categories')) return CATEGORY
      if (url.includes('/products/claim')) {
        claimedToken = opts.body?.cartToken
        return { mode: 'byCategory', got: 1, claimed: [{ id: 9001, code: 'HOFF-1' }] }
      }
      if (url.includes('/carts') && !url.match(/\/carts\/\d+/) && opts.method === 'POST') {
        throw new Error('POST /carts should not be called for a reusable guest token cart')
      }
      if (url.includes('/carts') && !url.match(/\/carts\/\d+/) && opts.method !== 'POST') {
        if (url.includes('cart_status')) return []
        if (url.includes(`cartToken=${GUEST_TOKEN}`)) return [STALE_GUEST_CART]
        return []
      }
      const put = url.match(/\/carts\/(\d+)/)
      if (put && opts.method === 'PUT') {
        return { ...STALE_GUEST_CART, cart_status: { id: 1, status: 'active' }, cartProducts: opts.body.cartProducts || [] }
      }
      if (url.includes('/products')) return []
      throw new Error(`Unmocked $fetch call: ${url}`)
    })

    const result = await addCheckoutCartItem({ cartToken: GUEST_TOKEN }, { categoryId: 59, response: 'minimal' })

    expect(result?.code).toBeUndefined()
    expect(result.cartId).toBe(88)
    expect(result.itemCount).toBe(1)
    expect(claimedToken).toBe(GUEST_TOKEN)
  })
})
