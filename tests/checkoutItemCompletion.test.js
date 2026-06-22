import { describe, it, expect } from 'vitest'
import {
  emptyCheckoutItemForm,
  isGiftOwnerComplete,
  isCheckoutItemComplete,
  isCheckoutProfileComplete
} from '../pages/checkout/composables/useCheckoutProgress.js'

const giftForm = (over = {}) => ({
  ...emptyCheckoutItemForm(),
  ownerMode: 'gift',
  firstName: 'Ada',
  lastName: 'Lovelace',
  email: 'ada@example.com',
  photo: { name: 'a.jpg', data: 'data:image/jpeg;base64,xxx' },
  ...over
})

describe('emptyCheckoutItemForm', () => {
  it('defaults ownerMode to empty (not "me") so the owner must be explicitly chosen', () => {
    expect(emptyCheckoutItemForm().ownerMode).toBe('')
  })
})

describe('isGiftOwnerComplete', () => {
  it('is true only with name, valid email and a photo', () => {
    expect(isGiftOwnerComplete(giftForm())).toBe(true)
  })
  it('is false without a photo', () => {
    expect(isGiftOwnerComplete(giftForm({ photo: null }))).toBe(false)
  })
  it('is false with a missing name', () => {
    expect(isGiftOwnerComplete(giftForm({ firstName: '  ' }))).toBe(false)
  })
  it('is false with an invalid email', () => {
    expect(isGiftOwnerComplete(giftForm({ email: 'not-an-email' }))).toBe(false)
  })
})

describe('isCheckoutItemComplete', () => {
  it('a plain non-transferable item with no pickup is complete', () => {
    expect(isCheckoutItemComplete({}, emptyCheckoutItemForm())).toBe(true)
  })

  it('requires a pickup location when the item has pickup options', () => {
    const item = { pickupLocations: [{ id: 1 }] }
    expect(isCheckoutItemComplete(item, emptyCheckoutItemForm())).toBe(false)
    expect(isCheckoutItemComplete(item, { ...emptyCheckoutItemForm(), pickupLocationId: 1 })).toBe(true)
  })

  it('a transferable item is INCOMPLETE until the owner is explicitly chosen (BUG 1)', () => {
    const item = { transferable: true }
    expect(isCheckoutItemComplete(item, emptyCheckoutItemForm())).toBe(false)
    expect(isCheckoutItemComplete(item, { ...emptyCheckoutItemForm(), ownerMode: 'me' })).toBe(true)
  })

  it('choosing only the pickup location does not complete a transferable item (BUG 1 core)', () => {
    const item = { transferable: true, pickupLocations: [{ id: 1 }] }
    const onlyPickup = { ...emptyCheckoutItemForm(), pickupLocationId: 1 }
    expect(isCheckoutItemComplete(item, onlyPickup)).toBe(false)
    expect(isCheckoutItemComplete(item, { ...onlyPickup, ownerMode: 'me' })).toBe(true)
  })

  it('a transferable gift item needs complete recipient details', () => {
    const item = { transferable: true }
    expect(isCheckoutItemComplete(item, { ...giftForm(), photo: null })).toBe(false)
    expect(isCheckoutItemComplete(item, giftForm())).toBe(true)
  })
})

describe('isCheckoutProfileComplete', () => {
  const profile = (over = {}) => ({
    firstName: 'Ada',
    lastName: 'Lovelace',
    email: 'ada@example.com',
    photo: { name: 'p.jpg', data: 'data:image/jpeg;base64,xxx' },
    ...over
  })

  it('is complete with name, valid email and a freshly chosen photo', () => {
    expect(isCheckoutProfileComplete(profile(), false)).toBe(true)
  })
  it('is complete when a photo is already on file (hasPicture), even without a new one', () => {
    expect(isCheckoutProfileComplete(profile({ photo: null }), true)).toBe(true)
  })
  it('is incomplete without any photo and no photo on file', () => {
    expect(isCheckoutProfileComplete(profile({ photo: null }), false)).toBe(false)
  })
  it('is incomplete with an invalid email', () => {
    expect(isCheckoutProfileComplete(profile({ email: 'nope' }), false)).toBe(false)
  })
  it('is incomplete with a missing name', () => {
    expect(isCheckoutProfileComplete(profile({ firstName: '  ' }), false)).toBe(false)
    expect(isCheckoutProfileComplete(profile({ lastName: '' }), false)).toBe(false)
  })
})
