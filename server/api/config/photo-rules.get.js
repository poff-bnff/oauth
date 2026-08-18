// Relative rather than the `~` alias, matching the other server routes. Only the constant is used
// here; the browser-only helpers in that module are never called server-side.
import { DEFAULT_PHOTO_RULES } from '../../../utils/photoRules.js'

// Proxies Strapi's GET /photo-rules to the browser.
//
// Server-side rather than fetched directly from the page for two reasons: it keeps the Strapi URL
// out of the browser, and it lets one cache serve every visitor instead of each of them hitting
// Strapi on page load.
//
// Never throws. A photo upload must not become impossible because a config fetch failed, so a
// Strapi outage degrades to DEFAULT_PHOTO_RULES — the same numbers, just frozen.

const CACHE_TTL_MS = 5 * 60 * 1000

let cached = null
let cachedAt = 0

export default defineEventHandler(async () => {
  const now = Date.now()

  if (cached && now - cachedAt < CACHE_TTL_MS) {
    return cached
  }

  const config = useRuntimeConfig()

  try {
    const rules = await $fetch(`${config.strapiUrl}/photo-rules`, { timeout: 5000 })

    // Guard against a 200 that is not the shape we expect (an HTML error page, an empty body):
    // merging garbage over the defaults would produce undefined limits, and an undefined minimum
    // silently disables the check it exists to enforce.
    if (rules && typeof rules === 'object' && Number(rules.minSourceWidth) > 0) {
      cached = { ...DEFAULT_PHOTO_RULES, ...rules }
      cachedAt = now
      return cached
    }

    console.warn('[photo-rules] unexpected response shape from Strapi, using defaults') // eslint-disable-line no-console
  } catch (err) {
    console.warn('[photo-rules] fetch failed, using defaults:', err?.message) // eslint-disable-line no-console
  }

  // Cached too, so a Strapi outage does not mean a failed fetch on every single request. The TTL
  // means it retries a few minutes later without anyone intervening.
  cached = { ...DEFAULT_PHOTO_RULES }
  cachedAt = now

  return cached
})
