import {
  checkoutLabelPayload,
  getStrapiConfig,
  getStrapiToken,
  loadLocalEnv,
  readCheckoutCopyDefaults,
  upsertCheckoutLabelGroup
} from './checkout-copy-strapi.mjs'

await loadLocalEnv()

const defaults = await readCheckoutCopyDefaults()
const payload = checkoutLabelPayload(defaults)
const config = getStrapiConfig()
const token = await getStrapiToken(config)
const savedGroup = await upsertCheckoutLabelGroup(config.baseUrl, token, payload)

console.log(`Seeded OAuth checkout labels in Strapi group "${savedGroup.name || payload.name}"`)
console.log(`Labels: ${payload.label.length}`)
