import checkoutCopyDefaults from './checkoutCopyDefaults.json'
import checkoutCopyOverrides from '../generated/checkoutCopy.json'

export const CHECKOUT_COPY_GROUP_NAMES = [
  'oauthCheckout',
  'oauth-checkout',
  'checkoutCopy',
  'checkout-copy'
]

export const CHECKOUT_COPY_DEFAULTS = checkoutCopyDefaults
export const CHECKOUT_COPY_OVERRIDES = checkoutCopyOverrides

const CHECKOUT_TEST_COPY_OVERRIDES = {
  en: {
    holdCart: 'We hold your cart for 24 hours of inactivity.',
    sessionExpiredText: 'Your session ended after 24 hours of inactivity and your cart was cleared. You can start a new order from the shop.'
  },
  et: {
    holdCart: 'Hoiame sinu ostukorvi 24 tundi tegevusetust.',
    sessionExpiredText: 'Sinu sessioon lõppes pärast 24 tundi tegevusetust ja ostukorv tühjendati. Saad alustada uut tellimust poest.'
  },
  ru: {
    holdCart: 'Мы держим вашу корзину 24 часа бездействия.',
    sessionExpiredText: 'Ваша сессия закончилась после 24 часов бездействия, и корзина была очищена. Вы можете начать новый заказ в магазине.'
  }
}

export function normalizeCheckoutLocale(locale) {
  return ['et', 'en', 'ru'].includes(locale) ? locale : 'en'
}

export function buildCheckoutCopy(locale, overridesByLocale = CHECKOUT_COPY_OVERRIDES) {
  const safeLocale = normalizeCheckoutLocale(locale)
  const defaults = CHECKOUT_COPY_DEFAULTS[safeLocale] || CHECKOUT_COPY_DEFAULTS.en || {}
  const overrides = withoutEmptyValues(overridesByLocale?.[safeLocale])
  const merged = { ...defaults, ...overrides, ...CHECKOUT_TEST_COPY_OVERRIDES[safeLocale] }
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
