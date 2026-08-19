import { getStrapiAdminToken, getStrapiUser, getUserIdFromEvent } from '../../../utils/strapi.js'
import { hitLimit } from '../../../utils/rateLimiter.js'

// Answers one question: what does this gift recipient still need the buyer to supply?
//
// So the checkout can ask for only the missing pieces, and say the rest is already on file without
// showing it. A buyer has no business seeing someone else's name or photo, but does need to know
// not to type them.
//
// RETURNS FIELD NAMES ONLY, NEVER VALUES. That is the whole point, and worth keeping true if this
// is ever extended.
//
// It is unavoidably an account-lookup oracle: a caller learns whether an address has an account and
// whether it has a photo. The checkout already leaked that at payment time, more confusingly — but a
// dedicated endpoint is scriptable in a way a full checkout is not, hence the login requirement and
// the rate limit.

const PROFILE_FIELDS = ['firstName', 'lastName', 'picture']

const LOOKUPS_PER_WINDOW = 30
const WINDOW_MS = 10 * 60 * 1000

const blank = value => !String(value == null ? '' : value).trim()

export default defineEventHandler(async (event) => {
  const userId = getUserIdFromEvent(event)
  if (!userId) throw createError({ statusCode: 401, statusMessage: 'Unauthorized' })

  // Keyed by buyer rather than IP: the point is to stop one account enumerating addresses, and a
  // shared office IP should not punish everyone behind it.
  const limit = hitLimit(`ownerlookup:${userId}`, LOOKUPS_PER_WINDOW, WINDOW_MS)
  if (limit.exceeded) {
    throw createError({ statusCode: 429, statusMessage: 'Too many lookups', data: { retryAfter: limit.retryAfter } })
  }

  const body = (await readBody(event)) || {}
  const email = String(body.email || '').trim().toLowerCase()

  if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    throw createError({ statusCode: 400, statusMessage: 'Invalid email' })
  }

  const config = useRuntimeConfig()

  try {
    const token = await getStrapiAdminToken()
    const users = await $fetch(`${config.strapiUrl}/users?email=${encodeURIComponent(email)}`, {
      headers: { Authorization: `Bearer ${token}` }
    })
    const existingUser = Array.isArray(users) ? users[0] : null

    // No account: the buyer supplies everything, as before.
    if (!existingUser) {
      return { existing: false, onFile: [], missing: PROFILE_FIELDS }
    }

    const user = await getStrapiUser(existingUser.id)
    const profile = user.user_profile || {}

    const onFile = PROFILE_FIELDS.filter(field => !blank(profile[field]))
    const missing = PROFILE_FIELDS.filter(field => blank(profile[field]))

    return { existing: true, onFile, missing }
  } catch (err) {
    // A failed lookup must not block the sale: the checkout falls back to asking for everything,
    // which is exactly how it behaved before this endpoint existed.
    console.warn('[checkout] owner lookup failed:', err?.message) // eslint-disable-line no-console
    return { existing: false, onFile: [], missing: PROFILE_FIELDS, degraded: true }
  }
})
