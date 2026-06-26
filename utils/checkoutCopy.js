import checkoutCopyDefaults from './checkoutCopyDefaults.json'
import checkoutCopyOverrides from '../generated/checkoutCopy.json'

export const CHECKOUT_COPY_GROUP_NAMES = [
  'checkout',
  'checkoutCopy',
  'checkout-copy',
  'oauthCheckout',
  'oauth-checkout'
]

export const CHECKOUT_COPY_DEFAULTS = checkoutCopyDefaults
export const CHECKOUT_COPY_OVERRIDES = checkoutCopyOverrides

export function normalizeCheckoutLocale(locale) {
  return ['et', 'en', 'ru'].includes(locale) ? locale : 'en'
}

export function buildCheckoutCopy(locale, overridesByLocale = CHECKOUT_COPY_OVERRIDES) {
  const safeLocale = normalizeCheckoutLocale(locale)
  const defaults = CHECKOUT_COPY_DEFAULTS[safeLocale] || CHECKOUT_COPY_DEFAULTS.en || {}
  const overrides = withoutEmptyValues(overridesByLocale?.[safeLocale])
  const merged = { ...defaults, ...overrides }
  const itemsRemovedTemplate = merged.itemsRemoved || CHECKOUT_COPY_DEFAULTS.en.itemsRemoved

  return {
    ...merged,
    itemsRemoved: count => String(itemsRemovedTemplate).replace(/\{count\}/g, count)
  }
}

export function normalizeCheckoutLabelGroups(labelGroups) {
  const groups = Array.isArray(labelGroups)
    ? labelGroups
    : Array.isArray(labelGroups?.data)
      ? labelGroups.data
      : []
  const checkoutGroup = unwrapStrapiEntity(groups.find(isCheckoutCopyGroup))
  const labels = checkoutGroup?.label || checkoutGroup?.labels || []
  if (!Array.isArray(labels)) return {}

  return labels.reduce((copy, label) => {
    const unwrappedLabel = unwrapStrapiEntity(label)
    const name = firstText(unwrappedLabel?.name, unwrappedLabel?.key, unwrappedLabel?.code)
    if (!name) return copy

    const localized = {
      en: localizedLabelValue(label, 'en'),
      et: localizedLabelValue(label, 'et'),
      ru: localizedLabelValue(label, 'ru')
    }

    for (const locale of ['en', 'et', 'ru']) {
      if (localized[locale]) copy[locale][name] = localized[locale]
    }

    return copy
  }, { en: {}, et: {}, ru: {} })
}

export function localizedLabelValue(label, locale = 'en') {
  const unwrappedLabel = unwrapStrapiEntity(label)
  const safeLocale = normalizeCheckoutLocale(locale)
  const titleLocale = safeLocale.charAt(0).toUpperCase() + safeLocale.slice(1)
  return firstText(
    unwrappedLabel?.[`value_${safeLocale}`],
    unwrappedLabel?.[`value${titleLocale}`],
    unwrappedLabel?.value?.[safeLocale],
    unwrappedLabel?.[safeLocale],
    unwrappedLabel?.value_en,
    unwrappedLabel?.valueEn,
    unwrappedLabel?.value?.en,
    unwrappedLabel?.en,
    unwrappedLabel?.value
  )
}

function normalizeGroupName(value) {
  return String(value || '').trim().toLowerCase().replace(/[-_\s]/g, '')
}

function unwrapStrapiEntity(entity) {
  return entity?.attributes ? { id: entity.id, ...entity.attributes } : entity
}

function isCheckoutCopyGroup(group) {
  const unwrappedGroup = unwrapStrapiEntity(group)
  const name = normalizeGroupName(unwrappedGroup?.name || unwrappedGroup?.slug || unwrappedGroup?.key)
  return CHECKOUT_COPY_GROUP_NAMES.some(groupName => normalizeGroupName(groupName) === name)
}

function firstText(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value
  }
  return ''
}

function withoutEmptyValues(overrides) {
  return Object.entries(overrides || {}).reduce((clean, [key, value]) => {
    if (typeof value === 'string' && value.trim()) clean[key] = value
    return clean
  }, {})
}
