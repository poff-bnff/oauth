import {
  CHECKOUT_COPY_GROUP_NAMES,
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
  const baked = countLabels(overrides)
  if (baked === 0) {
    // A successful fetch that matches no group looks identical to success in the build log. It is
    // not: it means every string silently falls back to the bundled defaults, and editing labels
    // in Strapi has no effect on the deployed shop.
    console.warn('Checkout copy bake found 0 labels — no matching label group in Strapi.')
    console.warn(`Looked for groups named: ${CHECKOUT_COPY_GROUP_NAMES.join(', ')}`)
    console.warn('The shop will run on bundled defaults; Strapi label edits will not appear.')
  } else {
    console.log(`Checkout copy baked from Strapi: ${baked} labels`)
  }
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
