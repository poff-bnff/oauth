/**
 * Nitro scheduled task: Fiona → Strapi bulk sync
 *
 * Runs every 15 minutes via the cron defined in nuxt.config.ts.
 * Calls runFionaSync() from server/utils/fionaSync.js.
 *
 * Requires Nitro ≥ 2.9 (experimentalTasks must be enabled in nitro config).
 * If Nitro scheduled tasks are not available in the deployed version, expose
 * the sync via a protected POST endpoint instead (see server/api/sync/fiona.post.js).
 */

import { runFionaSync } from '../utils/fionaSync.js'

export default defineTask({
  meta: {
    name: 'fiona:sync',
    description: 'Sync Fiona accreditations → Strapi users / people every 15 minutes'
  },
  async run ({ payload }) {
    const dryRun = payload?.dryRun === true
    console.log(`[task:fiona:sync] Starting${dryRun ? ' (DRY RUN)' : ''}`)

    const stats = await runFionaSync({ dryRun })

    return { result: stats }
  }
})
