import { describe, expect, test } from 'vitest'
import { checkoutErrorMessage, checkoutErrorInfo } from '../utils/checkoutErrors.js'
import { buildCheckoutCopy } from '../utils/checkoutCopy.js'

// Six distinct causes used to share one sentence — "check the item details" — which told the
// customer nothing about whether to fix their profile, choose a pickup point or change a recipient.
// Diagnosing one took a devtools session on 2026-08-19.

const copy = buildCheckoutCopy('en', {})
const items = [
  { productId: 8341, title: 'Test Pass et 1' },
  { productId: 9000, title: 'Hundipass 40' }
]

// Shaped like a real ofetch FetchError from the pay endpoint.
const failure = (data) => ({ statusCode: 400, data: { code: 400, ...data } })

describe('each cause gets its own message', () => {
  test('a missing pickup location names the item', () => {
    const message = checkoutErrorMessage(failure({ case: 'noDeliveryLocation', productId: 8341 }), copy, null, { items })
    expect(message).toContain('pickup location')
    expect(message).toContain('Test Pass et 1')
  })

  test('a gift without a photo names the item', () => {
    const message = checkoutErrorMessage(failure({ case: 'ownerPhotoRequired', productId: 9000 }), copy, null, { items })
    expect(message).toContain('Hundipass 40')
    expect(message).toContain('photo')
  })

  test('an incomplete buyer profile names the missing fields', () => {
    const message = checkoutErrorMessage(failure({ case: 'buyerProfileIncomplete', missing: ['firstName', 'picture'] }), copy)
    expect(message).toContain('a first name')
    expect(message).toContain('a photo')
  })

  test('the six causes no longer share one message', () => {
    const cases = ['buyerProfileIncomplete', 'ownerProfileIncomplete', 'ownerPhotoRequired',
      'invalidOwner', 'noDeliveryLocation', 'invalidDeliveryLocation']
    const messages = cases.map(c => checkoutErrorMessage(failure({ case: c, productId: 8341, missing: ['picture'] }), copy, null, { items }))
    expect(new Set(messages).size).toBe(cases.length)
  })
})

describe('token substitution degrades safely', () => {
  // The message must never show a raw %TOKEN% to a customer.
  test('an unknown product falls back to a generic phrase', () => {
    const message = checkoutErrorMessage(failure({ case: 'noDeliveryLocation', productId: 12345 }), copy, null, { items })
    expect(message).toContain('this item')
    expect(message).not.toContain('%ITEM%')
  })

  test('no cart items supplied still produces a usable sentence', () => {
    const message = checkoutErrorMessage(failure({ case: 'noDeliveryLocation', productId: 8341 }), copy)
    expect(message).not.toContain('%ITEM%')
  })

  test('an empty missing list does not leave a dangling phrase', () => {
    const message = checkoutErrorMessage(failure({ case: 'buyerProfileIncomplete', missing: [] }), copy)
    expect(message).toContain('some details')
    expect(message).not.toContain('%MISSING%')
  })

  test('an unrecognised field name is shown rather than dropped', () => {
    const message = checkoutErrorMessage(failure({ case: 'buyerProfileIncomplete', missing: ['birthdate'] }), copy)
    expect(message).toContain('birthdate')
  })
})

describe('the error details are carried through', () => {
  test('productId and missing are extracted from the nested data', () => {
    const info = checkoutErrorInfo(failure({ case: 'ownerProfileIncomplete', productId: 8341, missing: ['picture'] }))
    expect(info.case).toBe('ownerProfileIncomplete')
    expect(info.productId).toBe(8341)
    expect(info.missing).toEqual(['picture'])
  })

  test('absent details do not throw', () => {
    const info = checkoutErrorInfo({ statusCode: 500 })
    expect(info.productId).toBeNull()
    expect(info.missing).toEqual([])
  })
})

describe('every locale has the new strings', () => {
  test.each(['en', 'et', 'ru'])('%s', (locale) => {
    const localised = buildCheckoutCopy(locale, {})
    for (const key of ['checkoutBuyerProfileIncomplete', 'checkoutOwnerProfileIncomplete',
      'checkoutOwnerPhotoRequired', 'checkoutInvalidOwner', 'checkoutNoDeliveryLocation',
      'checkoutInvalidDeliveryLocation', 'fieldEmail', 'fieldFirstName', 'fieldLastName',
      'fieldPhoto', 'fieldSomeDetails', 'thisItem']) {
      expect(localised[key], `${locale}.${key}`).toBeTruthy()
    }
  })

  // A translator dropping a token would silently produce a worse message, not an error.
  test.each(['en', 'et', 'ru'])('%s keeps the %ITEM% token where the item matters', (locale) => {
    const localised = buildCheckoutCopy(locale, {})
    for (const key of ['checkoutOwnerPhotoRequired', 'checkoutNoDeliveryLocation', 'checkoutInvalidDeliveryLocation']) {
      expect(localised[key], `${locale}.${key}`).toContain('%ITEM%')
    }
  })
})
