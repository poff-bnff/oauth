/**
 * createLoaderCache — keeps what a loader returned for a short time, shares one running load between callers that ask for the
 * same key meanwhile, and never remembers a failure or an empty answer. Used by GET /api/my/appointments for the Strapi reads
 * that every page view repeated (the full user, the full person, the active guestbooks).
 */
import { describe, it, expect } from 'vitest'
import { createLoaderCache } from '../server/utils/fiona/loaderCache.js'

const MINUTE = 60 * 1000

function clock () {
  let t = 1_000_000
  return { now: () => t, advance: (ms) => { t += ms } }
}

// a loader that counts its calls and answers with `value`
function counting (value) {
  const loader = () => { loader.calls++; return Promise.resolve(value) }
  loader.calls = 0
  return loader
}

describe('createLoaderCache', () => {
  it('loads once and answers later calls from memory', async () => {
    const cache = createLoaderCache({ ttlMs: 2 * MINUTE, now: clock().now })
    const loader = counting({ id: 5 })

    expect(await cache.load(5, loader)).toEqual({ id: 5 })
    expect(await cache.load(5, loader)).toEqual({ id: 5 })
    expect(await cache.load(5, loader)).toEqual({ id: 5 })

    expect(loader.calls).toBe(1)
  })

  it('loads again once the copy is older than the time to live', async () => {
    const { now, advance } = clock()
    const cache = createLoaderCache({ ttlMs: 2 * MINUTE, now })
    const loader = counting('v')

    await cache.load('k', loader)
    advance(2 * MINUTE - 1)
    await cache.load('k', loader)
    expect(loader.calls).toBe(1)
    advance(1)
    await cache.load('k', loader)

    expect(loader.calls).toBe(2)
  })

  it('shares one load between callers that ask while it is still running', async () => {
    const cache = createLoaderCache({ ttlMs: MINUTE, now: clock().now })
    let release
    let calls = 0
    const loader = () => { calls++; return new Promise((resolve) => { release = () => resolve('slow') }) }

    const all = Promise.all([cache.load('k', loader), cache.load('k', loader), cache.load('k', loader)])
    release()

    expect(await all).toEqual(['slow', 'slow', 'slow'])
    expect(calls).toBe(1)
  })

  it('does not remember a failure: every waiting caller gets it, the next call tries again', async () => {
    const cache = createLoaderCache({ ttlMs: MINUTE, now: clock().now })
    let calls = 0
    const loader = () => { calls++; return calls === 1 ? Promise.reject(new Error('504 Gateway Time-out')) : Promise.resolve('ok') }

    const both = await Promise.allSettled([cache.load('k', loader), cache.load('k', loader)])
    expect(both.map(result => result.status)).toEqual(['rejected', 'rejected'])
    expect(await cache.load('k', loader)).toBe('ok')

    expect(calls).toBe(2)
  })

  it('does not remember an empty answer (a user that was not found yet)', async () => {
    const cache = createLoaderCache({ ttlMs: MINUTE, now: clock().now })
    const nothing = counting(null)
    const undefinedLoader = counting(undefined)

    await cache.load('a', nothing)
    await cache.load('a', nothing)
    await cache.load('b', undefinedLoader)
    await cache.load('b', undefinedLoader)

    expect(nothing.calls).toBe(2)
    expect(undefinedLoader.calls).toBe(2)
  })

  it('keeps keys apart', async () => {
    const cache = createLoaderCache({ ttlMs: MINUTE, now: clock().now })

    expect(await cache.load(1, counting('one'))).toBe('one')
    expect(await cache.load(2, counting('two'))).toBe('two')
    expect(await cache.load(1, counting('changed'))).toBe('one')
  })

  it('forgets the oldest entry when it holds more than maxEntries', async () => {
    const cache = createLoaderCache({ ttlMs: MINUTE, maxEntries: 2, now: clock().now })
    const first = counting('first')

    await cache.load('a', first)
    await cache.load('b', counting('b'))
    await cache.load('c', counting('c')) // pushes "a" out
    await cache.load('a', first)

    expect(first.calls).toBe(2)
  })

  it('can be cleared', async () => {
    const cache = createLoaderCache({ ttlMs: MINUTE, now: clock().now })
    const loader = counting('v')

    await cache.load('k', loader)
    cache.clear()
    await cache.load('k', loader)

    expect(loader.calls).toBe(2)
  })
})
