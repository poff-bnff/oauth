import { describe, it, expect } from 'vitest'
import { createCachingLookup } from '../server/plugins/network-resilience.js'

const OPTS = { all: true } // undici calls lookup with { hints, all: true }
const ok = addr => (h, o, cb) => cb(null, [{ address: addr, family: 4 }])
const fail = code => (h, o, cb) => cb(Object.assign(new Error(code), { code }))
const call = (cl, host, opts = OPTS) => new Promise(resolve => cl(host, opts, (err, ...args) => resolve({ err, args })))

describe('cachingLookup — DNS resilience', () => {
  it('caches a successful lookup; the second call is served from cache (no re-resolve)', async () => {
    let calls = 0
    const cl = createCachingLookup({ lookup: (h, o, cb) => { calls++; ok('1.2.3.4')(h, o, cb) } })
    expect((await call(cl, 'strapi')).args).toEqual([[{ address: '1.2.3.4', family: 4 }]])
    expect((await call(cl, 'strapi')).args).toEqual([[{ address: '1.2.3.4', family: 4 }]])
    expect(calls).toBe(1)
  })

  it('serves the last known-good result when a fresh lookup fails (rides through EAI_AGAIN)', async () => {
    let mode = ok('1.2.3.4')
    const cl = createCachingLookup({ lookup: (h, o, cb) => mode(h, o, cb), ttlMs: 0, maxRetries: 0 })
    await call(cl, 'strapi') // warm the cache (ttl 0 → next call re-resolves)
    mode = fail('EAI_AGAIN')
    const { err, args } = await call(cl, 'strapi')
    expect(err).toBeNull() // did NOT fail
    expect(args).toEqual([[{ address: '1.2.3.4', family: 4 }]]) // served the stale-but-good IP
  })

  it('retries a transient EAI_AGAIN before succeeding', async () => {
    let calls = 0
    const cl = createCachingLookup({
      retryDelayMs: 1,
      lookup: (h, o, cb) => { calls++; (calls < 2 ? fail('EAI_AGAIN') : ok('5.6.7.8'))(h, o, cb) }
    })
    expect((await call(cl, 'strapi')).args).toEqual([[{ address: '5.6.7.8', family: 4 }]])
    expect(calls).toBe(2) // retried once
  })

  it('propagates the error when resolution fails and there is no cached result', async () => {
    const cl = createCachingLookup({ lookup: fail('ENOTFOUND') })
    expect((await call(cl, 'strapi')).err?.code).toBe('ENOTFOUND')
  })
})
