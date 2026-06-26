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
  const token = await getStrapiToken(config)
  const labelGroups = await fetchCheckoutLabelGroups(config.baseUrl, token)
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
