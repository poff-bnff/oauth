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
const copyDefaults = JSON.parse(read('../utils/checkoutCopyDefaults.json'))
const profileStepSource = read('../pages/checkout/components/CheckoutProfileStep.vue')

describe('checkout item step source', () => {
  test('uses shared checkout progress item keys', () => {
    expect(checkoutItemStepSource).toContain("from '../composables/useCheckoutProgress.js'")
    expect(checkoutItemStepSource).toContain('itemKey')
    expect(checkoutItemStepSource).not.toMatch(/function\s+itemKey\s*\(/)
  })
})

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

describe('BUG 3 — prefilled invoice form for users with no billing profiles', () => {
  test('a guard re-opens the prefilled create form for a 0-profile "me" user', () => {
    expect(indexSource).toContain('watch([step, invoiceFor, invoiceView, () => profiles.value.length, selectedBillingProfileId]')
    expect(indexSource).toContain("startInvoiceForm('personal', 'me')")
  })
  test('returnToInvoiceList sends a 0-profile user to step 1 instead of an empty list', () => {
    expect(indexSource).toMatch(/if \(!profiles\.value\.length\)\s*\{\s*step\.value = 1;\s*return\s*\}/)
  })
})

describe('BUG 4 — save-as-profile default off + native toggle', () => {
  test('saveAsInvoiceProfile defaults to false', () => {
    expect(indexSource).toContain('const saveAsInvoiceProfile = ref(false)')
  })
  test('the create flow (startInvoiceForm) leaves it off', () => {
    expect(indexSource).toMatch(/saveAsInvoiceProfile\.value = false/)
  })
  test('the checkbox label no longer uses @click.prevent (native toggle, not a Vue round-trip)', () => {
    expect(invoiceStepSource).not.toContain('@click.prevent')
    expect(invoiceStepSource).toContain("@change=\"$emit('update:saveAsInvoiceProfile', $event.target.checked)\"")
  })
})

describe('profile step — save button gated on completeness', () => {
  test('uses the shared isCheckoutProfileComplete predicate', () => {
    expect(progressSource).toContain('export function isCheckoutProfileComplete')
    expect(profileStepSource).toContain('isCheckoutProfileComplete')
  })
  test('the save button is disabled until the form is complete', () => {
    expect(profileStepSource).toContain(':disabled="saving || !isProfileComplete"')
  })
})

describe('STEP 4 / BUG 5 — light profile-save refresh', () => {
  test('a refreshBusinessProfiles helper fetches only the profiles', () => {
    expect(indexSource).toContain('async function refreshBusinessProfiles')
    expect(indexSource).toMatch(/refreshBusinessProfiles[\s\S]*\$fetch\('\/api\/business-profiles'/)
  })
  test('both save paths use the light refresh (refreshBusinessProfiles appears 3×: def + 2 calls)', () => {
    expect(indexSource.match(/refreshBusinessProfiles/g)?.length).toBeGreaterThanOrEqual(3)
  })
})

describe('BUG 8 — empty-cart state', () => {
  test('the header (title + session banner) is gated on a non-empty cart', () => {
    expect(indexSource).toContain("v-if=\"transactionResult !== 'success' && cart.items.length\"")
  })
  test('an empty cart renders the centered card with a Go to shop CTA using the shared button style', () => {
    expect(indexSource).toContain('class="cart-empty"')
    expect(indexSource).toContain('class="primary cart-empty-go"')
    expect(indexSource).toContain('copy.goToShop')
    expect(indexSource).toContain('copy.emptyHint')
  })
  test('the copy defines goToShop and emptyHint', () => {
    expect(copyDefaults.en.goToShop).toBeTruthy()
    expect(copyDefaults.en.emptyHint).toBeTruthy()
    expect(copyDefaults.et.goToShop).toBeTruthy()
    expect(copyDefaults.ru.emptyHint).toBeTruthy()
  })
})

describe('checkout context refresh metadata stability', () => {
  test('background refreshes preserve existing pickup options when a shallow cart response omits them', () => {
    expect(indexSource).toContain('function preserveCheckoutItemDetails')
    expect(indexSource).toContain('previous?.pickupLocations?.length')
    expect(indexSource).toContain('const sameProduct =')
    expect(indexSource).toContain('const sameCategory =')
    expect(indexSource).toContain('return { ...item, pickupLocations: previous.pickupLocations }')
    expect(indexSource).toMatch(/context\.value = preserveCheckoutItemDetails\(nextContext, previousItems\)/)
  })
})

describe('checkout action error display', () => {
  test('page-level errors hide raw fetch/network internals from users', () => {
    expect(indexSource).toContain("from '../../utils/checkoutErrors.js'")
    expect(indexSource).toContain('checkoutErrorMessage(err, copy.value')
    expect(indexSource).toContain("console.warn('[checkout] context load failed'")
    expect(indexSource).toContain('copy.value.checkoutPaymentFailed')
    expect(indexSource).not.toContain("err?.data?.statusMessage || err?.message || 'Could not remove item'")
  })

  test('remove refreshes the cart before showing a friendly fallback error', () => {
    expect(indexSource).toContain("console.warn('[checkout] cart item remove failed'")
    expect(indexSource).toMatch(/catch \(err\)[\s\S]*await refreshContext\(\)[\s\S]*checkoutCartUpdateFailedMessage\(\)/)
    expect(copyDefaults.en.cartUpdateFailed).toBeTruthy()
    expect(copyDefaults.et.cartUpdateFailed).toBeTruthy()
    expect(copyDefaults.ru.cartUpdateFailed).toBeTruthy()
  })

  test('profile save errors are logged for developers and shown as friendly copy', () => {
    expect(profileStepSource).toContain("from '../../../utils/checkoutErrors.js'")
    expect(profileStepSource).toContain("console.warn('[checkout] profile save failed'")
    expect(profileStepSource).toContain('checkoutErrorMessage(err, props.copy, props.copy.checkoutProfileSaveFailed)')
    expect(profileStepSource).not.toMatch(/err\?\.data\?\.statusMessage|err\?\.message/)
  })
})

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

describe('checkout auth gating — unauthenticated/expired sessions go to login', () => {
  test('no token redirects to login', () => {
    expect(indexSource).toMatch(/if \(!token\.value\) \{[\s\S]*?redirect_uri=/)
  })
  test('a 401 from the context fetch clears the stale token and redirects to login (not empty cart)', () => {
    expect(indexSource).toMatch(/statusCode === 401 \|\| err\?\.data\?\.case === 'unauthorized'/)
    expect(indexSource).toContain('tokenCookie.value = null')
  })
  test('the login redirect is a full-page navigation so the login page actually loads', () => {
    // client-side nav left the checkout view mounted; external:true loads index.vue (which redirects to OAuth)
    expect(indexSource).not.toMatch(/redirect_uri=[\s\S]*?\{ external: false \}/)
    expect(indexSource).toMatch(/redirect_uri=[\s\S]*?\{ external: true \}/)
  })
  test('the empty-cart card never renders without a token (no flash while redirecting to login)', () => {
    expect(indexSource).toContain('v-if="!cart.items.length && token"')
  })
})

describe('recipient lookup indicator does not reflow the gift form', () => {
  const checkoutCss = read('../pages/checkout/checkout.css')

  // The indicator used to be its own <p class="span"> in the form grid, so starting and finishing
  // a lookup moved the first-name and last-name fields under the buyer's cursor.
  test('the pending state is not rendered as a grid cell', () => {
    expect(checkoutItemStepSource).not.toMatch(/<p[^>]*class="span[^"]*"[^>]*>\s*\{\{\s*copy\.checkingRecipient/)
  })

  test('the spinner is inside the email field and takes it out of flow', () => {
    expect(checkoutItemStepSource).toMatch(/owner-email-input[\s\S]{0,800}owner-lookup-spinner/)
    expect(checkoutCss).toMatch(/\.owner-lookup-spinner\s*\{[^}]*position:\s*absolute/)
  })

  // Both states share one slot whose height is reserved, so switching between them cannot move
  // the fields below.
  test('the status slot reserves its height', () => {
    expect(checkoutCss).toMatch(/\.owner-status\s*\{[^}]*min-height/)
  })

  test('a stale on-file message cannot show beside a running check', () => {
    expect(checkoutItemStepSource).toMatch(/ownerLookupPending[\s\S]{0,300}v-else-if="giftOnFile/)
  })

  test('the pending state is announced to screen readers', () => {
    expect(checkoutItemStepSource).toMatch(/aria-live="polite"[\s\S]{0,300}copy\.checkingRecipient/)
  })

  // A hung Strapi must not leave a spinner turning with no way out.
  test('the lookup is bounded by a timeout that falls back to asking for everything', () => {
    expect(checkoutItemStepSource).toContain('OWNER_LOOKUP_TIMEOUT_MS')
    expect(checkoutItemStepSource).toMatch(/AbortController[\s\S]{0,300}signal: abort\.signal/)
  })
})
