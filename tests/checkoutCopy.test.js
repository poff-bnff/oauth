import { describe, expect, test } from 'vitest'
import {
  buildCheckoutCopy,
  normalizeCheckoutLabelGroups,
  normalizeCheckoutLocale
} from '../utils/checkoutCopy.js'

describe('checkout copy defaults and build-time overrides', () => {
  test('uses English as the fallback locale', () => {
    expect(normalizeCheckoutLocale('fr')).toBe('en')
    expect(buildCheckoutCopy('fr', {}).completeOrder).toBe('Complete your order')
  })

  test('keeps locale-specific defaults', () => {
    expect(buildCheckoutCopy('et', {}).completeOrder).toBe('Lõpeta tellimus')
    expect(buildCheckoutCopy('ru', {}).completeOrder).toBe('Завершите заказ')
  })

  test('applies generated overrides only for the requested locale', () => {
    const overrides = {
      en: { completeOrder: 'Finish checkout' },
      et: {},
      ru: {}
    }

    expect(buildCheckoutCopy('en', overrides).completeOrder).toBe('Finish checkout')
    expect(buildCheckoutCopy('et', overrides).completeOrder).toBe('Lõpeta tellimus')
  })

  test('formats the removed-items notice after merging copy', () => {
    const copy = buildCheckoutCopy('en', {
      en: { itemsRemoved: '{count} item(s) were dropped.' },
      et: {},
      ru: {}
    })

    expect(copy.itemsRemoved(3)).toBe('3 item(s) were dropped.')
  })

  test('defines friendly checkout error messages for every supported locale', () => {
    const keys = [
      'checkoutLoadFailed',
      'checkoutPaymentFailed',
      'checkoutInvoiceSaveFailed',
      'checkoutProfileSaveFailed',
      'checkoutNetwork',
      'checkoutBusy',
      'checkoutUnexpected',
      'checkoutSessionInvalid',
      'checkoutCartEmpty',
      'checkoutChoosePaymentMethod',
      'checkoutInvoiceProfileInvalid',
      'checkoutDetailsInvalid',
      'checkoutItemUnavailable',
      'cartUpdateFailed'
    ]

    for (const locale of ['en', 'et', 'ru']) {
      const copy = buildCheckoutCopy(locale, {})
      for (const key of keys) {
        expect(copy[key], `${locale}.${key}`).toBeTruthy()
        expect(copy[key], `${locale}.${key}`).not.toMatch(/\[[A-Z]+\]|Bad Request|Internal Server Error|FetchError|statusCode|undefined|null/i)
      }
    }
  })
})

describe('checkout copy Strapi label-group normalization', () => {
  test('extracts checkout labels from Strapi v3 response shape', () => {
    const normalized = normalizeCheckoutLabelGroups([
      {
        name: 'oauthCheckout',
        label: [
          {
            name: 'completeOrder',
            value_en: 'Complete from Strapi',
            value_et: 'Lõpeta Strapis',
            value_ru: 'Завершить из Strapi'
          }
        ]
      }
    ])

    expect(normalized.en.completeOrder).toBe('Complete from Strapi')
    expect(normalized.et.completeOrder).toBe('Lõpeta Strapis')
    expect(normalized.ru.completeOrder).toBe('Завершить из Strapi')
  })

  test('does not read the web2021 shop checkout label group', () => {
    const normalized = normalizeCheckoutLabelGroups([
      {
        name: 'checkout',
        label: [
          {
            name: 'addToCart',
            value_en: 'Add to cart'
          }
        ]
      }
    ])

    expect(normalized.en).toEqual({})
    expect(normalized.et).toEqual({})
    expect(normalized.ru).toEqual({})
  })

  test('accepts wrapped entity response shape and falls back to English label values', () => {
    const normalized = normalizeCheckoutLabelGroups({
      data: [
        {
          id: 7,
          attributes: {
            name: 'oauth-checkout',
            labels: [
              {
                attributes: {
                  name: 'emptyHint',
                  value_en: 'English fallback'
                }
              }
            ]
          }
        }
      ]
    })

    expect(normalized.en.emptyHint).toBe('English fallback')
    expect(normalized.et.emptyHint).toBe('English fallback')
    expect(normalized.ru.emptyHint).toBe('English fallback')
  })
})

// The labels live in a group named 'checkout' — that is what the seeder fills and what
// domain_specifics.yaml watches for the deploy trigger. Leaving it out of this list made every
// build bake 0 labels while reporting success, so Strapi edits never reached the shop.
describe('the label group the shop reads matches the one Strapi fills', () => {
  test("'checkout' is among the group names looked for", async () => {
    const { CHECKOUT_COPY_GROUP_NAMES } = await import('../scripts/checkout-copy-strapi.mjs')
    expect(CHECKOUT_COPY_GROUP_NAMES).toContain('checkout')
  })

  test('a group named checkout is normalized into per-locale copy', async () => {
    const { normalizeCheckoutLabelGroups } = await import('../scripts/checkout-copy-strapi.mjs')
    const overrides = normalizeCheckoutLabelGroups([
      {
        name: 'checkout',
        label: [
          { name: 'holdCart', value_en: 'We hold your cart.', value_et: 'Hoiame ostukorvi.', value_ru: 'Держим корзину.' }
        ]
      }
    ])
    expect(overrides.et.holdCart).toBe('Hoiame ostukorvi.')
    expect(overrides.en.holdCart).toBe('We hold your cart.')
    expect(overrides.ru.holdCart).toBe('Держим корзину.')
  })

  test('an unrelated group still yields nothing, so the match stays specific', async () => {
    const { normalizeCheckoutLabelGroups } = await import('../scripts/checkout-copy-strapi.mjs')
    const overrides = normalizeCheckoutLabelGroups([
      { name: 'userprofile', label: [{ name: 'cropTitle', value_et: 'Kärbi' }] }
    ])
    expect(Object.values(overrides).every(locale => Object.keys(locale || {}).length === 0)).toBe(true)
  })
})
