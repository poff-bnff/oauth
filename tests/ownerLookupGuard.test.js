import { describe, expect, test } from 'vitest'
import { emptyCheckoutItemForm, shouldLookupOwner } from '../pages/checkout/composables/useCheckoutProgress.js'

const EMAIL = 'mariannehelenar@gmail.com'

describe('recipient lookup in-flight guard', () => {
  test('a fresh address is looked up', () => {
    expect(shouldLookupOwner(emptyCheckoutItemForm(), EMAIL)).toBe(true)
  })

  // The live bug: Safari fires blur more than once, so two lookups ran at once. The first to
  // return cleared the pending flag while the second was still running, leaving a spinner turning
  // beside an answer that had already arrived.
  test('a second blur for the same address while one is in flight is dropped', () => {
    const form = emptyCheckoutItemForm()
    form.ownerLookupPending = true
    form.ownerLookupFor = EMAIL
    expect(shouldLookupOwner(form, EMAIL)).toBe(false)
  })

  test('a different address supersedes an in-flight lookup', () => {
    const form = emptyCheckoutItemForm()
    form.ownerLookupPending = true
    form.ownerLookupFor = EMAIL
    expect(shouldLookupOwner(form, 'someone.else@example.com')).toBe(true)
  })

  test('an address already answered is not asked about again', () => {
    const form = emptyCheckoutItemForm()
    form.ownerOnFile = { email: EMAIL, existing: true, onFile: ['firstName'], missing: [] }
    expect(shouldLookupOwner(form, EMAIL)).toBe(false)
  })

  test('an empty address is never sent', () => {
    expect(shouldLookupOwner(emptyCheckoutItemForm(), '')).toBe(false)
  })

  test('the form starts with no lookup in flight', () => {
    const form = emptyCheckoutItemForm()
    expect(form.ownerLookupPending).toBe(false)
    expect(form.ownerLookupFor).toBe('')
  })
})
