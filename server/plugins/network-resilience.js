import dns from 'node:dns'
import { Agent, setGlobalDispatcher } from 'undici'

// Outbound resilience for every server-side fetch (Strapi, Maksekeskus, OAuth.ee, …).
//
// The dev box hit sustained `getaddrinfo EAI_AGAIN devs.poff.ee` — the container's DNS resolver
// failing transiently — which took down cart/checkout because Node re-resolves DNS on every
// connection. This installs a global undici dispatcher that:
//   1. caches successful DNS results briefly (fewer lookups), and
//   2. serves the last known-good result if a fresh lookup fails (rides through a DNS blip), and
//   3. retries a transient EAI_AGAIN a couple of times before giving up.
// plus HTTP keep-alive so connections (and their resolved IPs) are reused.
//
// IMPORTANT: retry here is at the DNS-RESOLUTION level only — it never replays an HTTP request, so a
// non-idempotent POST (e.g. /orders, /carts) can NEVER be double-executed. A genuine request failure
// still surfaces normally (and the add path's boundary catch turns it into a clean 503). This is a
// blip-smoother, not a substitute for the infra fix (a private/direct route to Strapi).

export function createCachingLookup ({ lookup = dns.lookup, ttlMs = 30_000, maxRetries = 2, retryDelayMs = 120 } = {}) {
  const cache = new Map() // key -> { args, expires }

  function resolve (hostname, options, attempt, cb) {
    lookup(hostname, options, (err, ...args) => {
      if (!err) return cb(null, args)
      // EAI_AGAIN = transient resolver failure; the request was never sent, so retrying is safe.
      if (err.code === 'EAI_AGAIN' && attempt < maxRetries) {
        return setTimeout(() => resolve(hostname, options, attempt + 1, cb), retryDelayMs * (attempt + 1))
      }
      return cb(err)
    })
  }

  return function cachingLookup (hostname, options, callback) {
    const key = `${hostname}|${options?.family || 0}|${options?.all ? 1 : 0}|${options?.hints || 0}`
    const cached = cache.get(key)
    if (cached && cached.expires > Date.now()) return callback(null, ...cached.args)
    resolve(hostname, options, 0, (err, args) => {
      if (!err) {
        cache.set(key, { args, expires: Date.now() + ttlMs })
        return callback(null, ...args)
      }
      // Fresh resolution failed — serve the last known-good result rather than failing the request.
      if (cached) return callback(null, ...cached.args)
      return callback(err)
    })
  }
}

export function installNetworkResilience () {
  const agent = new Agent({
    connect: { lookup: createCachingLookup() },
    keepAliveTimeout: 30_000, // reuse idle connections (and their resolved IPs) for 30s
    keepAliveMaxTimeout: 60_000
  })
  setGlobalDispatcher(agent)
  return agent
}

export default defineNitroPlugin(() => {
  if (process.env.NODE_ENV === 'test') return
  try {
    installNetworkResilience()
    // eslint-disable-next-line no-console
    console.log('[net] resilient dispatcher installed (DNS cache + serve-stale + keep-alive)')
  } catch (err) {
    // Never let this break startup — fall back to the default dispatcher.
    // eslint-disable-next-line no-console
    console.error('[net] failed to install resilient dispatcher, using default:', err)
  }
})
