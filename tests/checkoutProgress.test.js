import { describe, expect, it } from 'vitest'
import {
  buildCheckoutProgressSnapshot,
  cartSignature,
  emptyCheckoutItemForm,
  findCompatibleSavedForm,
  itemKey,
  matchCheckoutProgressForms
} from '../pages/checkout/composables/useCheckoutProgress.js'

const ITEM_A = { componentId: 100, productId: 7255, categoryId: 109, index: 0 }
const ITEM_B = { componentId: 101, productId: 7256, categoryId: 109, index: 1 }

describe('checkout progress item keys', () => {
  it('uses stable componentId when available', () => {
    expect(itemKey(ITEM_A, 0)).toBe('component:100')
    expect(cartSignature([ITEM_A, ITEM_B])).toBe('component:100|component:101')
  })

  it('falls back to product/index for legacy or incomplete cart rows', () => {
    expect(itemKey({ productId: 1, index: 7 }, 0)).toBe('product:1-7')
    expect(itemKey({ productId: 1 }, 3)).toBe('product:1-3')
  })
})

describe('checkout progress compatibility restore', () => {
  it('restores a legacy productId-index form when the same item is now keyed by componentId', () => {
    const form = { ...emptyCheckoutItemForm(), pickupLocationId: 'loc-1' }
    const savedForms = { '7255-0': form }

    expect(findCompatibleSavedForm(savedForms, ITEM_A, 0)).toEqual(form)
    expect(matchCheckoutProgressForms(savedForms, [ITEM_A])).toEqual([['component:100', form]])
  })

  it('restores a legacy form after an earlier item was removed and the remaining row index shifted', () => {
    const form = { ...emptyCheckoutItemForm(), pickupLocationId: 'loc-b', ownerMode: 'me' }
    const savedFormsBeforeRemoval = {
      '7255-0': { ...emptyCheckoutItemForm(), pickupLocationId: 'loc-a' },
      '7256-1': form
    }

    // ITEM_B is now the first remaining row. The old key was 7256-1; current legacy key would
    // be 7256-0, so productId-only migration is needed.
    expect(matchCheckoutProgressForms(savedFormsBeforeRemoval, [{ ...ITEM_B, index: 0 }]))
      .toEqual([['component:101', form]])
  })

  it('does not use productId-only migration when duplicate products would be ambiguous', () => {
    const savedForms = {
      '7255-0': { ...emptyCheckoutItemForm(), pickupLocationId: 'loc-a' },
      '7255-1': { ...emptyCheckoutItemForm(), pickupLocationId: 'loc-b' }
    }

    expect(findCompatibleSavedForm(savedForms, { productId: 7255, componentId: 999, index: 0 }, 0))
      .toEqual(savedForms['7255-0'])
    expect(findCompatibleSavedForm(savedForms, { productId: 7255, componentId: 999, index: 3 }, 3))
      .toBeNull()
  })
})

describe('checkout progress snapshot', () => {
  it('stores only current cart item forms and prunes removed rows', () => {
    const itemForms = {
      'component:100': { ...emptyCheckoutItemForm(), pickupLocationId: 'removed-loc' },
      'component:101': { ...emptyCheckoutItemForm(), pickupLocationId: 'kept-loc' }
    }

    const snapshot = buildCheckoutProgressSnapshot({
      items: [ITEM_B],
      itemForms,
      step: 3,
      openItemKey: 'component:101',
      invoiceForm: { email: 'buyer@example.ee' },
      selectedBillingProfileId: 42,
      invoiceView: 'selected',
      invoiceFormType: 'personal',
      invoiceFor: 'me',
      saveAsInvoiceProfile: true
    })

    expect(Object.keys(snapshot.itemForms)).toEqual(['component:101'])
    expect(snapshot.itemForms['component:101'].pickupLocationId).toBe('kept-loc')
    expect(snapshot.itemForms['component:100']).toBeUndefined()
  })

  it('never persists uploaded gift photo payloads', () => {
    const itemForms = {
      'component:100': {
        ...emptyCheckoutItemForm(),
        ownerMode: 'gift',
        firstName: 'Gift',
        lastName: 'Person',
        email: 'gift@example.ee',
        photo: 'data:image/jpeg;base64,large',
        photoName: 'gift.jpg',
        photoError: 'old error'
      }
    }

    const snapshot = buildCheckoutProgressSnapshot({
      items: [ITEM_A],
      itemForms,
      step: 1,
      invoiceForm: {}
    })

    expect(snapshot.itemForms['component:100']).toMatchObject({
      ownerMode: 'gift',
      firstName: 'Gift',
      photo: null,
      photoName: '',
      photoError: ''
    })
  })
})
