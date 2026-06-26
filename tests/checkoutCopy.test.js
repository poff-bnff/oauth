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
})

describe('checkout copy Strapi label-group normalization', () => {
  test('extracts checkout labels from Strapi v3 response shape', () => {
    const normalized = normalizeCheckoutLabelGroups([
      {
        name: 'checkout',
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
