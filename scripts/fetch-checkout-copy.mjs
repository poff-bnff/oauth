import {
  fetchCheckoutLabelGroups,
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
      const token = await getStrapiToken(config)
      return fetchCheckoutLabelGroups(config.baseUrl, token)
        .catch((authenticatedReadError) => {
          authenticatedReadError.message = `${authenticatedReadError.message}; public read also failed: ${publicReadError.message}`
          throw authenticatedReadError
        })
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
