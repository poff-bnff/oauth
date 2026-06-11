import { getClientIp } from '../utils/clientIp.js'
import { hitLimit } from '../utils/rateLimiter.js'

const GENERAL = { max: 60, windowMs: 60_000 }      // any cart op: 60/min/IP
const CREATE  = { max: 10, windowMs: 10 * 60_000 } // anon cart creation: 10/10min/IP

export default defineEventHandler((event) => {
  const path = event.path || ''
  if (!path.startsWith('/api/cart')) return

  const ip = getClientIp(event)
  const h = getRequestHeaders(event)

  const g = hitLimit(`cart:${ip}`, GENERAL.max, GENERAL.windowMs)
  if (g.exceeded) {
    throw createError({ statusCode: 429, statusMessage: 'Too many requests', data: { retryAfter: g.retryAfter } })
  }

  // Extra cap on anonymous cart creation: POST /api/cart/items with no token of any kind.
  // Only meaningful once WS2 opens the endpoint to guests; harmless until then.
  const isAnonCreate = event.method === 'POST'
    && path.split('?')[0] === '/api/cart/items'
    && !h['x-cart-token']
    && !h['authorization']
  if (isAnonCreate) {
    const c = hitLimit(`cartnew:${ip}`, CREATE.max, CREATE.windowMs)
    if (c.exceeded) {
      throw createError({ statusCode: 429, statusMessage: 'Too many new carts', data: { retryAfter: c.retryAfter } })
    }
  }
})
