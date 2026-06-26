/**
 * Cart concurrency tests — proves the per-cart mutex serializes overlapping ops.
 *
 * The mock is *stateful*: a PUT to /carts/:id updates an in-memory object that the
 * next GET inside the lock returns. Without the mutex both concurrent adds would
 * read the same empty-cart state and their PUTs would overwrite each other
 * (last-write-wins → one item lost). With the mutex they serialize and the second
 * add re-reads the first's committed result before building its PUT.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { addCheckoutCartItem, removeCheckoutCartItem } from '../server/utils/strapi.js'

const NOW = '2026-06-10T12:00:00.000Z'
const GUEST_TOKEN = 'conc-test-token'

const ADMIN_JWT_PAYLOAD = Buffer.from(
  JSON.stringify({ exp: Math.floor(new Date(NOW).getTime() / 1000) + 3600 })
).toString('base64url')
const ADMIN_JWT = `${Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url')}.${ADMIN_JWT_PAYLOAD}.sig`

const ACTIVE_PRICE_PERIOD = {
  startDateTime: '2026-01-01T00:00:00.000Z',
  endDateTime: '2027-01-01T00:00:00.000Z',
  price: 30
}
const ACTIVE_SALES_PERIOD = {
  startDateTime: '2026-01-01T00:00:00.000Z',
  endDateTime: '2027-01-01T00:00:00.000Z'
}

const CATEGORY = {
  id: 100,
  codePrefix: 'CONC-PASS-2026',
  namePrivate: 'Concurrency test pass',
  priceAtPeriod: [ACTIVE_PRICE_PERIOD],
  salesPeriod: [ACTIVE_SALES_PERIOD],
  pickup_locations: [],
  business_profile: { id: 1 }
}

const PRODUCT_A = {
  id: 7001, code: 'CONC-2026-0001', active: true,
  product_category: CATEGORY, reserved_to: null, sold_to: null, owner: null, transactions: []
}
const PRODUCT_B = {
  id: 7002, code: 'CONC-2026-0002', active: true,
  product_category: CATEGORY, reserved_to: null, sold_to: null, owner: null, transactions: []
}

function makeCart(id, cartProducts = []) {
  return {
    id,
    cartProducts,
    cartUpdatedAt: NOW,
    cartTimeout: null,
    cartToken: GUEST_TOKEN,
    cart_status: { id: 1, status: 'active' },
    users_permissions_user: null,
    locale: 'et'
  }
}

/**
 * Builds a $fetch mock backed by a mutable in-memory cart. Each PUT synchronously
 * commits the new cartProducts so the very next GET inside the lock sees the
 * updated state — exactly what a serializing mutex must guarantee.
 *
 * availableProducts is the pool returned by the products-availability query.
 * addCheckoutCartItem does its own client-side exclusion of existingProductIds,
 * so returning the full pool here is correct and realistic.
 */
function makeStatefulFetch(cart, availableProducts) {
  let state = { ...cart, cartProducts: cart.cartProducts.map(r => ({ ...r })) }
  const cartId = cart.id
  let nextComponentId = 1000
  const claimedIds = new Set()

  return vi.fn().mockImplementation(async (url, opts) => {
    if (url.includes('/admin/login')) return { data: { token: ADMIN_JWT } }
    if (url.includes('/cart-statuses')) return [{ id: 1, status: 'active' }]
    if (url.includes('/product-categories')) return CATEGORY

    // /products/claim — atomically reserve a product (simulates FOR UPDATE SKIP LOCKED). Guests and
    // users both claim now; hand out the next unclaimed product so parallel adds never collide.
    if (url.includes('/products/claim') && opts?.method === 'POST') {
      const body = opts.body || {}
      if (body.transfer) return { claimed: [] }
      if (Array.isArray(body.productIds)) return { claimed: body.productIds.map(id => ({ id, code: `PROD-${id}` })) }
      const qty = Math.max(1, Number(body.quantity || 1))
      const claimed = []
      for (const p of availableProducts) {
        if (claimed.length >= qty) break
        if (!claimedIds.has(p.id)) { claimedIds.add(p.id); claimed.push({ id: p.id, code: p.code }) }
      }
      return { claimed }
    }

    // Products availability — return the full pool; the function filters by excludedProductIds
    if (url.includes('/products') && !url.match(/\/products\/\d+/)) {
      return [...availableProducts]
    }

    // GET /carts (list) — used by expireStaleCheckoutCarts and getCurrentCheckoutCart
    if (url.includes('/carts') && !url.match(/\/carts\/\d+/) && opts?.method !== 'POST') {
      return [state]
    }

    // PUT /carts/:id — commit the update and return the new state
    if (url.includes(`/carts/${cartId}`) && opts?.method === 'PUT') {
      const body = opts.body
      if (body.cartProducts !== undefined) {
        const resolved = body.cartProducts.map(row => {
          const pid = row.product?.id ?? row.product
          const product = availableProducts.find(p => p.id === pid)
            || state.cartProducts.find(r => (r.product?.id ?? r.product) === pid)?.product
            || { id: pid, code: `PROD-${pid}`, product_category: CATEGORY }
          return {
            id: row.id ?? nextComponentId++,
            product,
            priceInCart: row.priceInCart,
            timeToCart: row.timeToCart
          }
        })
        state = { ...state, cartProducts: resolved, cartUpdatedAt: body.cartUpdatedAt ?? state.cartUpdatedAt }
      } else {
        state = { ...state, ...body }
      }
      return state
    }

    throw new Error(`Unmocked $fetch: ${opts?.method ?? 'GET'} ${url}`)
  })
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date(NOW))
})
afterEach(() => { vi.useRealTimers() })

// ── Concurrent add ─────────────────────────────────────────────────────────────

describe('cart concurrency — concurrent adds', () => {
  it('two parallel adds both land: no items lost', async () => {
    const cart = makeCart(600)
    globalThis.$fetch = makeStatefulFetch(cart, [PRODUCT_A, PRODUCT_B])

    const [r1, r2] = await Promise.all([
      addCheckoutCartItem({ cartToken: GUEST_TOKEN }, { categoryId: CATEGORY.id }),
      addCheckoutCartItem({ cartToken: GUEST_TOKEN }, { categoryId: CATEGORY.id })
    ])

    // Neither op returns an error
    expect(r1.code).toBeUndefined()
    expect(r2.code).toBeUndefined()
    // The last op to complete sees both items in the cart
    const finalItems = (r2.items?.length ?? 0) >= (r1.items?.length ?? 0) ? r2.items : r1.items
    expect(finalItems).toHaveLength(2)
    const productIds = finalItems.map(i => i.productId)
    expect(productIds).toContain(PRODUCT_A.id)
    expect(productIds).toContain(PRODUCT_B.id)
  })
})

// ── Concurrent add + remove ────────────────────────────────────────────────────

describe('cart concurrency — concurrent add and remove', () => {
  it('add and remove serialize: final cart has exactly one item', async () => {
    // Cart starts with PRODUCT_A (componentId 901). Concurrently add PRODUCT_B
    // and remove PRODUCT_A. Regardless of which op acquires the lock first, the
    // final cart must contain exactly PRODUCT_B.
    const initialRow = { id: 901, product: PRODUCT_A, priceInCart: 30, timeToCart: NOW }
    const cart = makeCart(601, [initialRow])
    globalThis.$fetch = makeStatefulFetch(cart, [PRODUCT_B])

    const [addResult, removeResult] = await Promise.all([
      addCheckoutCartItem({ cartToken: GUEST_TOKEN }, { categoryId: CATEGORY.id }),
      removeCheckoutCartItem({ cartToken: GUEST_TOKEN }, { componentId: 901 })
    ])

    expect(addResult.code).toBeUndefined()
    expect(removeResult.code).toBeUndefined()
    // At least one result reflects a final cart with 1 item (PRODUCT_B)
    const itemCounts = [addResult, removeResult]
      .map(r => r.items?.length)
      .filter(n => n !== undefined)
    expect(itemCounts).toContain(1)
    const oneItemResult = [addResult, removeResult].find(r => r.items?.length === 1)
    expect(oneItemResult.items[0].productId).toBe(PRODUCT_B.id)
  })
})

// ── Identity-based remove ──────────────────────────────────────────────────────

describe('identity-based remove — componentId takes priority', () => {
  it('removes the row matching componentId regardless of its array position', async () => {
    // Cart has two rows. Remove by componentId targets the first row (PRODUCT_A)
    // even though productId and index are not supplied.
    const rowA = { id: 902, product: PRODUCT_A, priceInCart: 30, timeToCart: NOW }
    const rowB = { id: 903, product: PRODUCT_B, priceInCart: 30, timeToCart: NOW }
    const cart = makeCart(602, [rowA, rowB])
    globalThis.$fetch = makeStatefulFetch(cart, [PRODUCT_A, PRODUCT_B])

    const result = await removeCheckoutCartItem({ cartToken: GUEST_TOKEN }, { componentId: 902 })

    expect(result.code).toBeUndefined()
    expect(result.items).toHaveLength(1)
    expect(result.items[0].productId).toBe(PRODUCT_B.id)
    expect(result.items[0].componentId).toBe(903)
  })

  it('falls back to productId when componentId is not supplied', async () => {
    const rowA = { id: 904, product: PRODUCT_A, priceInCart: 30, timeToCart: NOW }
    const rowB = { id: 905, product: PRODUCT_B, priceInCart: 30, timeToCart: NOW }
    const cart = makeCart(603, [rowA, rowB])
    globalThis.$fetch = makeStatefulFetch(cart, [PRODUCT_A, PRODUCT_B])

    const result = await removeCheckoutCartItem(
      { cartToken: GUEST_TOKEN },
      { productId: String(PRODUCT_A.id) }
    )

    expect(result.code).toBeUndefined()
    expect(result.items).toHaveLength(1)
    expect(result.items[0].productId).toBe(PRODUCT_B.id)
  })
})
