import { expireStaleCheckoutCarts, getCleanupState, saveCleanupState, runStartupCartRecovery, deleteStaleGuestCarts } from '../utils/strapi.js'

const RECOVERY_THRESHOLD_MS = 5 * 60 * 1000
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000

let cleanupIntervalId = null

export default defineNitroPlugin(async (nitroApp) => {
  const cleanupEnabled = process.env.NODE_ENV !== 'test'
  let didRecover = false

  try {
    const state = await getCleanupState()
    const lastRun = state?.lastCleanupRun ? new Date(state.lastCleanupRun).getTime() : null
    const gap = lastRun ? Date.now() - lastRun : null

    if (gap !== null && gap > RECOVERY_THRESHOLD_MS) {
      console.log(`[cleanup] Detected ${Math.round(gap / 60000)}min downtime — extending active carts`)
      const count = await runStartupCartRecovery()
      const saved = await saveCleanupState({ lastCleanupRun: new Date().toISOString() })
      if (!saved) console.warn('[cleanup] Failed to save cleanup state after recovery')
      console.log(`[cleanup] Recovery complete: extended ${count} active carts`)
      didRecover = true
    }
  } catch (err) {
    console.error('[cleanup] Startup recovery failed:', err.message)
  }

  if (!cleanupEnabled) {
    console.log('[cleanup] Dev mode — scheduled cleanup disabled')
    return
  }

  if (cleanupIntervalId) return

  if (!didRecover) {
    try {
      const result = await expireStaleCheckoutCarts()
      const saved = await saveCleanupState({ lastCleanupRun: new Date().toISOString() })
      if (!saved) console.warn('[cleanup] Failed to save cleanup state after initial run')
      console.log(`[cleanup] Initial cleanup: expired ${result.expired}/${result.checked} carts`)
    } catch (err) {
      console.error('[cleanup] Initial cleanup failed:', err.message)
    }
  }

  cleanupIntervalId = setInterval(async () => {
    try {
      const result = await expireStaleCheckoutCarts()
      const saved = await saveCleanupState({ lastCleanupRun: new Date().toISOString() })
      if (!saved) console.warn('[cleanup] Failed to save cleanup state')
      if (result.expired > 0) console.log(`[cleanup] Expired ${result.expired}/${result.checked} carts`)
    } catch (err) {
      console.error('[cleanup] Scheduled cleanup failed:', err.message)
    }
    try {
      const { deleted } = await deleteStaleGuestCarts()
      if (deleted > 0) console.log(`[cleanup] Hard-deleted ${deleted} stale guest carts`)
    } catch (err) {
      console.error('[cleanup] Guest cart hard-delete failed:', err.message)
    }
  }, CLEANUP_INTERVAL_MS)

  nitroApp.hooks.hookOnce('close', () => {
    if (cleanupIntervalId) {
      clearInterval(cleanupIntervalId)
      cleanupIntervalId = null
    }
  })

  console.log('[cleanup] Scheduled cleanup started (every 5 min)')
})
