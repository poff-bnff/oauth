import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { addCheckoutCartItem } from '../server/utils/strapi.js'

const NOW = '2026-06-02T12:00:00.000Z'
const USER_ID = 14783
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
})
