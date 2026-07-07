import { describe, expect, test } from 'vitest'
import { checkoutErrorInfo, checkoutErrorMessage } from '../utils/checkoutErrors.js'
import { buildCheckoutCopy } from '../utils/checkoutCopy.js'

const copy = buildCheckoutCopy('en', {})

describe('checkout error messages', () => {
  test('maps payment validation cases to friendly copy', () => {
    const err = { data: { data: { case: 'noPaymentMethod' }, statusCode: 400 } }

    expect(checkoutErrorMessage(err, copy, copy.checkoutPaymentFailed)).toBe(copy.checkoutChoosePaymentMethod)
  })

  test('maps unavailable products to friendly copy', () => {
    const err = { data: { data: { case: 'productUnavailable' }, statusCode: 409 } }

    expect(checkoutErrorMessage(err, copy, copy.checkoutPaymentFailed)).toBe(copy.checkoutItemUnavailable)
  })

  test('hides raw fetch banners from users', () => {
    const err = { message: '[POST] "/api/checkout/pay": <no response> NetworkError when attempting to fetch resource.' }

    expect(checkoutErrorMessage(err, copy, copy.checkoutPaymentFailed)).toBe(copy.checkoutNetwork)
  })

  test('hides raw backend/server errors from users', () => {
    const err = { data: { statusCode: 500, statusMessage: '500 Internal Server Error' } }

    expect(checkoutErrorMessage(err, copy, copy.checkoutPaymentFailed)).toBe(copy.checkoutUnexpected)
  })

  test('maps overloaded shop responses to busy copy', () => {
    for (const statusCode of [429, 502, 503]) {
      const err = { data: { statusCode, statusMessage: `${statusCode} upstream overloaded` } }

      expect(checkoutErrorMessage(err, copy, copy.checkoutPaymentFailed)).toBe(copy.checkoutBusy)
    }
  })

  test('maps timeout responses to connection copy', () => {
    for (const statusCode of [408, 504]) {
      const err = { data: { statusCode, statusMessage: `${statusCode} timeout` } }

      expect(checkoutErrorMessage(err, copy, copy.checkoutPaymentFailed)).toBe(copy.checkoutNetwork)
    }
  })

  test('replaces terse legacy payment errors with recovery copy', () => {
    expect(checkoutErrorMessage({ message: 'Payment failed' }, copy, copy.checkoutPaymentFailed)).toBe(copy.checkoutPaymentFailed)
  })

  test('keeps safe custom validation copy', () => {
    const message = 'Please choose or add an invoice profile.'

    expect(checkoutErrorMessage({ message }, copy, copy.checkoutPaymentFailed)).toBe(message)
  })

  test('extracts status and case from Nuxt createError shape', () => {
    const info = checkoutErrorInfo({ data: { data: { case: 'invalidBillingProfile' }, statusCode: 400 } })

    expect(info).toMatchObject({
      case: 'invalidBillingProfile',
      status: 400,
      isNetwork: false
    })
  })
})
