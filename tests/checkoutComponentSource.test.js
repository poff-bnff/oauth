import { describe, expect, test } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const read = (rel) => readFileSync(resolve(__dirname, rel), 'utf8')

const checkoutItemStepSource = read('../pages/checkout/components/CheckoutItemStep.vue')
const indexSource = read('../pages/checkout/index.vue')
const invoiceStepSource = read('../pages/checkout/components/CheckoutInvoiceStep.vue')
const progressSource = read('../pages/checkout/composables/useCheckoutProgress.js')
const copySource = read('../pages/checkout/composables/useCheckoutCopy.js')
const profileStepSource = read('../pages/checkout/components/CheckoutProfileStep.vue')

describe('checkout item step source', () => {
  test('uses shared checkout progress item keys', () => {
    expect(checkoutItemStepSource).toContain("from '../composables/useCheckoutProgress.js'")
    expect(checkoutItemStepSource).toContain('itemKey')
    expect(checkoutItemStepSource).not.toMatch(/function\s+itemKey\s*\(/)
  })
})

// BUG 1 — explicit owner choice; completion logic is shared (not duplicated) so the two views can't drift.
describe('BUG 1 — explicit owner choice', () => {
  test('emptyCheckoutItemForm defaults ownerMode to empty', () => {
    expect(progressSource).toMatch(/ownerMode:\s*''/)
  })
  test('completion logic is exported from the shared composable', () => {
    expect(progressSource).toContain('export function isCheckoutItemComplete')
    expect(progressSource).toContain('export function isGiftOwnerComplete')
  })
  test('both views import the shared completion logic and do not re-define it', () => {
    expect(indexSource).toContain('isCheckoutItemComplete')
    expect(checkoutItemStepSource).toContain('isCheckoutItemComplete')
    expect(indexSource).not.toMatch(/function\s+isGiftOwnerComplete\s*\(/)
    expect(checkoutItemStepSource).not.toMatch(/function\s+isGiftOwnerComplete\s*\(/)
  })
})

// BUG 3 — no-profile users always get the prefilled "for me" form, never the empty list.
describe('BUG 3 — prefilled invoice form for users with no billing profiles', () => {
  test('a guard re-opens the prefilled create form for a 0-profile "me" user', () => {
    expect(indexSource).toContain('watch([step, invoiceFor, invoiceView, () => profiles.value.length, selectedBillingProfileId]')
    expect(indexSource).toContain("startInvoiceForm('personal', 'me')")
  })
  test('returnToInvoiceList sends a 0-profile user to step 1 instead of an empty list', () => {
    expect(indexSource).toMatch(/if \(!profiles\.value\.length\)\s*\{\s*step\.value = 1;\s*return\s*\}/)
  })
})

// BUG 4 — "save as profile" is off by default for new profiles and the checkbox toggles natively.
describe('BUG 4 — save-as-profile default off + native toggle', () => {
  test('saveAsInvoiceProfile defaults to false', () => {
    expect(indexSource).toContain('const saveAsInvoiceProfile = ref(false)')
  })
  test('the create flow (startInvoiceForm) leaves it off', () => {
    expect(indexSource).toMatch(/saveAsInvoiceProfile\.value = false[^\n]*BUG 4/)
  })
  test('the checkbox label no longer uses @click.prevent (native toggle, not a Vue round-trip)', () => {
    expect(invoiceStepSource).not.toContain('@click.prevent')
    expect(invoiceStepSource).toContain("@change=\"$emit('update:saveAsInvoiceProfile', $event.target.checked)\"")
  })
})

// Guest-login profile step — "Save & continue" disabled until the profile form is complete/valid.
describe('profile step — save button gated on completeness', () => {
  test('uses the shared isCheckoutProfileComplete predicate', () => {
    expect(progressSource).toContain('export function isCheckoutProfileComplete')
    expect(profileStepSource).toContain('isCheckoutProfileComplete')
  })
  test('the save button is disabled until the form is complete', () => {
    expect(profileStepSource).toContain(':disabled="saving || !isProfileComplete"')
  })
})

// BUG 8 — empty cart shows a centered "Go to shop" card, with the header + session timer hidden.
describe('BUG 8 — empty-cart state', () => {
  test('the header (title + session banner) is gated on a non-empty cart', () => {
    expect(indexSource).toContain("v-if=\"transactionResult !== 'success' && cart.items.length\"")
  })
  test('an empty cart renders the centered card with a Go to shop CTA using the shared button style', () => {
    expect(indexSource).toContain('class="cart-empty"')
    expect(indexSource).toContain('class="primary cart-empty-go"') // same .primary styling as Continue
    expect(indexSource).toContain('copy.goToShop')
    expect(indexSource).toContain('copy.emptyHint')
  })
  test('the copy defines goToShop and emptyHint', () => {
    expect(copySource).toContain('goToShop:')
    expect(copySource).toContain('emptyHint:')
  })
})

// BUG 6 — gift photos persisted in IndexedDB; wiring present on save/restore/cleanup paths.
describe('BUG 6 — gift photo IndexedDB wiring', () => {
  test('the item step stashes and clears photos', () => {
    expect(checkoutItemStepSource).toContain("from '../composables/useCheckoutPhotoStore.js'")
    expect(checkoutItemStepSource).toContain('savePhoto(')
    expect(checkoutItemStepSource).toContain('deletePhoto(')
  })
  test('the page rehydrates on restore and cleans up on success / remove / prune', () => {
    expect(indexSource).toContain("from './composables/useCheckoutPhotoStore.js'")
    expect(indexSource).toContain('getPhoto(')
    expect(indexSource).toContain('clearAllPhotos()')
    expect(indexSource).toContain('prunePhotosExcept(')
    expect(indexSource).toContain('deletePhoto(itemKey(item))')
  })
})
