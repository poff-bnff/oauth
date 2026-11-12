/**
 * fiona/loaderCache.js
 *
 * Keeps what a loader returned for a short time and shares one running load between callers that ask for the same key meanwhile.
 * A failure and an empty answer (null / undefined) are never remembered. Used by GET /api/my/appointments for the Strapi reads
 * that every page view repeated: the full user, the full person, the active guestbooks (2026-11-12: Strapi was overloaded).
 * In memory, per process; a restart starts empty.
 */
export function createLoaderCache ({ ttlMs, maxEntries = 500, now = Date.now } = {}) {
  const entries = new Map() // key → { value, at }, oldest first
  const running = new Map() // key → the load in progress

  function remember (key, value) {
    entries.delete(key)
    entries.set(key, { value, at: now() })
    while (entries.size > maxEntries) entries.delete(entries.keys().next().value)
  }

  return {
    load (key, loader) {
      const hit = entries.get(key)
      if (hit && now() - hit.at < ttlMs) return Promise.resolve(hit.value)
      if (running.has(key)) return running.get(key)

      let started
      try { started = Promise.resolve(loader()) } catch (err) { started = Promise.reject(err) }
      const load = started
        .then((value) => {
          if (value !== null && value !== undefined) remember(key, value)
          return value
        })
        .finally(() => { running.delete(key) })
      running.set(key, load)
      return load
    },
    clear () {
      entries.clear()
      running.clear()
    }
  }
}
