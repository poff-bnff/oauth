import {
  fetchCheckoutLabelGroups,
  getStrapiAdminToken,
  getStrapiConfig,
  getStrapiToken,
  loadLocalEnv,
  normalizeCheckoutLabelGroups,
  writeCheckoutCopyOverrides
} from './checkout-copy-strapi.mjs'

await loadLocalEnv()

try {
  const config = getStrapiConfig()
  const labelGroups = await fetchCheckoutLabelGroups(config.baseUrl, null)
    .catch(async (publicReadError) => {
      const adminReadError = await readWithAdminToken(config).then(
        labelGroups => ({ labelGroups }),
        error => ({ error })
      )
      if (adminReadError.labelGroups) return adminReadError.labelGroups

      const contentReadError = await readWithContentToken(config).then(
        labelGroups => ({ labelGroups }),
        error => ({ error })
      )
      if (contentReadError.labelGroups) return contentReadError.labelGroups

      const error = contentReadError.error
      error.message = [
        error.message,
        `admin read failed: ${adminReadError.error.message}`,
        `public read failed: ${publicReadError.message}`
      ].join('; ')
      throw error
    })
  const overrides = normalizeCheckoutLabelGroups(labelGroups)

  await writeCheckoutCopyOverrides(overrides)
  console.log(`Checkout copy baked from Strapi: ${countLabels(overrides)} labels`)
} catch (error) {
  await writeCheckoutCopyOverrides({})
  console.warn(`Checkout copy bake skipped: ${error.message}`)
  console.warn('Using bundled English/Estonian/Russian defaults.')
}

function countLabels(overrides) {
  return Object.values(overrides || {}).reduce((total, localeCopy) => {
    return total + Object.keys(localeCopy || {}).length
  }, 0)
}

async function readWithAdminToken(config) {
  const token = await getStrapiAdminToken(config)
  return fetchCheckoutLabelGroups(config.baseUrl, token)
}

async function readWithContentToken(config) {
  const token = await getStrapiToken(config)
  return fetchCheckoutLabelGroups(config.baseUrl, token)
}
