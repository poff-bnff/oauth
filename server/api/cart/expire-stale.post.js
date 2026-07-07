// POST /api/cart/expire-stale
// Protected by x-sync-secret header (NUXT_SYNC_SECRET).
// Idempotent — safe to call from a cron job every minute.
// Returns { checked, expired } counts.
export default defineEventHandler(async (event) => {
  const config = useRuntimeConfig()
  const secret = config.syncSecret

  if (!secret) {
    throw createError({ statusCode: 503, statusMessage: 'Sync secret not configured' })
  }

  const headers = getRequestHeaders(event)
  if (headers['x-sync-secret'] !== secret) {
    throw createError({ statusCode: 401, statusMessage: 'Unauthorized' })
  }

  const result = await expireStaleCheckoutCarts()
  return result
})
