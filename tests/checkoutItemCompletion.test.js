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
  // Typed twice since 2026-08-19: a mistyped address landing on a real account would otherwise
  // pass silently as "details on file" and send the pass to a stranger.
  emailConfirm: 'ada@example.com',
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

  it('is false when the confirmation does not match', () => {
    expect(isGiftOwnerComplete(giftForm({ emailConfirm: 'typo@example.com' }))).toBe(false)
    expect(isGiftOwnerComplete(giftForm({ emailConfirm: '' }))).toBe(false)
  })

  it('ignores case when comparing the two addresses', () => {
    // Nobody should be blocked because they capitalised one of them.
    expect(isGiftOwnerComplete(giftForm({ emailConfirm: 'Ada@Example.com' }))).toBe(true)
  })
})

// The recipient's account may already hold some of this. The buyer is asked only for what is
// missing, and never shown what is there.
describe('a recipient with details already on file', () => {
  const withOnFile = (onFile, over = {}) => giftForm({ ownerOnFile: { email: 'ada@example.com', existing: true, onFile }, ...over })

  it('does not require a photo the recipient already has', () => {
    expect(isGiftOwnerComplete(withOnFile(['picture'], { photo: null }))).toBe(true)
  })

  it('does not require a name the recipient already has', () => {
    expect(isGiftOwnerComplete(withOnFile(['firstName', 'lastName'], { firstName: '', lastName: '' }))).toBe(true)
  })

  it('requires nothing but a matching email when everything is on file', () => {
    expect(isGiftOwnerComplete(withOnFile(['firstName', 'lastName', 'picture'], { firstName: '', lastName: '', photo: null }))).toBe(true)
  })

  it('still requires the fields that are NOT on file', () => {
    expect(isGiftOwnerComplete(withOnFile(['firstName'], { firstName: '', photo: null }))).toBe(false)
  })

  // The safe default: if the lookup never ran or failed, ask for everything, exactly as before.
  it('requires everything when nothing is known about the recipient', () => {
    expect(isGiftOwnerComplete(giftForm({ ownerOnFile: null, photo: null }))).toBe(false)
    expect(isGiftOwnerComplete(giftForm({ ownerOnFile: { email: 'x', onFile: 'not-an-array' }, photo: null }))).toBe(false)
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
