import { buildCheckoutCopy } from '../../../utils/checkoutCopy.js'

/**
 * User-visible strings for the checkout flow.
 * Defaults are bundled with OAuth; Strapi overrides are baked at build time.
 */
export function useCheckoutCopy(locale) {
  return computed(() => buildCheckoutCopy(locale.value))
}
