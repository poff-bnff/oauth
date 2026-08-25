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
    // The third element is the key the form was found under — what a photo saved under the old key
    // has to be migrated from.
    expect(matchCheckoutProgressForms(savedForms, [ITEM_A])).toEqual([['component:100', form, '7255-0']])
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
      .toEqual([['component:101', form, '7256-1']])
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

// A gift photo lives in IndexedDB keyed by item, while the form is matched across item identity
// changes. Without the key it was saved under, the photo cannot follow the form: the buyer is told
// to upload again for no reason, and prunePhotosExcept then deletes the orphan for good.
describe('a restored form reports the key its photo was stored under', () => {
  it('reports the old key when the item has been re-keyed', () => {
    const form = { ...emptyCheckoutItemForm(), ownerMode: 'gift' }
    const [[currentKey, , savedKey]] = matchCheckoutProgressForms({ '7255-0': form }, [ITEM_A])
    expect(currentKey).toBe('component:100')
    expect(savedKey).toBe('7255-0')
    expect(savedKey).not.toBe(currentKey)
  })

  it('reports the same key when nothing moved, so no migration is attempted', () => {
    const form = { ...emptyCheckoutItemForm(), ownerMode: 'gift' }
    const [[currentKey, , savedKey]] = matchCheckoutProgressForms({ 'component:100': form }, [ITEM_A])
    expect(savedKey).toBe(currentKey)
  })
})
