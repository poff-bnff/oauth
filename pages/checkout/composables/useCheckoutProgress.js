export const CHECKOUT_PROGRESS_KEY = 'poff_checkout_progress'

export function itemKey (item, index = 0) {
  if (item?.componentId != null) return `component:${item.componentId}`
  return `product:${item?.productId}-${item?.index ?? index}`
}

export function legacyItemKey (item, index = 0) {
  return `${item?.productId}-${item?.index ?? index}`
}

export function cartSignature (items = []) {
  return items.map((item, index) => itemKey(item, index)).join('|')
}

export function emptyCheckoutItemForm () {
  return {
    pickupLocationId: '',
    ownerMode: '',
    firstName: '',
    lastName: '',
    email: '',
    photo: null,
    photoName: '',
    photoError: '',
    sendEmail: true,
    // Typo guard. A mistyped address that happens to belong to a real account would otherwise sail
    // through as "details already on file" and send the pass to a stranger.
    emailConfirm: '',
    // What the recipient's account already holds, from /api/checkout/owner/lookup. FIELD NAMES
    // ONLY — a buyer has no business seeing someone else's name or photo, only knowing not to
    // type them.
    ownerOnFile: null,
    // Which address the in-flight lookup is for, so a duplicate blur cannot start a second one
    // and a superseded response cannot overwrite a newer answer.
    ownerLookupFor: '',
    ownerLookupPending: false
  }
}

// Whether a lookup for `email` should actually be sent.
//
// Extracted from the component because this is where the bug lived: Safari fires blur more than
// once (moving to the next field, autofill, window blur), and without the in-flight check two
// requests raced — the first cleared the pending flag while the second was still running, leaving
// a spinner turning next to an answer that had already arrived.
export function shouldLookupOwner (form, email) {
  if (!email) return false
  if (form.ownerOnFile && form.ownerOnFile.email === email) return false // already answered
  if (form.ownerLookupPending && form.ownerLookupFor === email) return false // already asking
  return true
}

// Fields the buyer must still supply. Everything when nothing is known about the recipient, which
// keeps the old behaviour whenever the lookup has not run or failed.
export function giftFieldsStillNeeded (form = {}) {
  const onFile = form.ownerOnFile
  if (!onFile || !Array.isArray(onFile.onFile)) return ['firstName', 'lastName', 'picture']

  return ['firstName', 'lastName', 'picture'].filter(field => !onFile.onFile.includes(field))
}

export function isGiftOwnerComplete (form = {}) {
  const email = (form.email || '').trim()
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return false
  // Compared case-insensitively: nobody should be blocked because they capitalised one of them.
  if (email.toLowerCase() !== (form.emailConfirm || '').trim().toLowerCase()) return false

  const needed = giftFieldsStillNeeded(form)
  if (needed.includes('firstName') && !(form.firstName || '').trim()) return false
  if (needed.includes('lastName') && !(form.lastName || '').trim()) return false
  if (needed.includes('picture') && !form.photo) return false

  return true
}

export function isCheckoutItemComplete (item = {}, form = {}) {
  if (item.pickupLocations?.length && !form.pickupLocationId) return false
  if (item.transferable) {
    if (form.ownerMode !== 'me' && form.ownerMode !== 'gift') return false
    if (form.ownerMode === 'gift') return isGiftOwnerComplete(form)
  }
  return true
}

export function isCheckoutProfileComplete (form = {}, hasPicture = false) {
  return !!(
    (form.firstName || '').trim() &&
    (form.lastName || '').trim() &&
    /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test((form.email || '').trim()) &&
    (form.photo || hasPicture)
  )
}

// Returns { key, form }: the form AND the key it was stored under, which are not always the same.
// Callers that hold anything else keyed by item — the gift photos in IndexedDB — need the old key
// to follow the form across an item identity change.
export function findCompatibleSavedFormEntry (source, item, index = 0) {
  if (!source || !item) return null
  const key = itemKey(item, index)
  if (source[key]) return { key, form: source[key] }

  const previousKey = legacyItemKey(item, index)
  if (source[previousKey]) return { key: previousKey, form: source[previousKey] }

  // Migration for progress saved before componentId keys existed. If an earlier item was
  // removed, the remaining item's old productId-index key no longer matches its current index.
  // Use productId-only fallback only when it is unambiguous, so duplicate products don't inherit
  // each other's owner/pickup data.
  const productPrefix = `${item.productId}-`
  const productMatches = Object.entries(source).filter(([savedKey]) => savedKey.startsWith(productPrefix))
  return productMatches.length === 1 ? { key: productMatches[0][0], form: productMatches[0][1] } : null
}

export function findCompatibleSavedForm (source, item, index = 0) {
  return findCompatibleSavedFormEntry(source, item, index)?.form || null
}

export function serializableCheckoutItemForm (form = {}) {
  // ownerOnFile is kept: it holds field NAMES only, no personal data, and re-running the lookup
  // after every reload would be needless traffic against a rate-limited endpoint.
  return { ...form, photo: null, photoName: '', photoError: '' }
}

export function buildCheckoutProgressSnapshot ({
  items = [],
  itemForms = {},
  step,
  openItemKey,
  invoiceForm,
  selectedBillingProfileId,
  invoiceView,
  invoiceFormType,
  invoiceFor,
  saveAsInvoiceProfile
}) {
  const forms = {}
  const itemMeta = {}
  for (const [index, item] of items.entries()) {
    const key = itemKey(item, index)
    const form = findCompatibleSavedForm(itemForms, item, index) || emptyCheckoutItemForm()
    forms[key] = serializableCheckoutItemForm(form)
    itemMeta[key] = {
      componentId: item.componentId ?? null,
      productId: item.productId ?? null,
      categoryId: item.categoryId ?? null,
      index: item.index ?? index
    }
  }

  return {
    sig: cartSignature(items),
    itemKeys: items.map((item, index) => itemKey(item, index)),
    itemMeta,
    step,
    openItemKey,
    itemForms: forms,
    invoiceForm: { ...(invoiceForm || {}) },
    selectedBillingProfileId,
    invoiceView,
    invoiceFormType,
    invoiceFor,
    saveAsInvoiceProfile
  }
}

// Each entry is [currentKey, form, savedKey]. savedKey differs from currentKey whenever the item
// changed identity, and anything else stored under the old key has to be migrated, not dropped.
export function matchCheckoutProgressForms (savedForms = {}, currentItems = []) {
  const matchedForms = []
  for (const [index, item] of currentItems.entries()) {
    const key = itemKey(item, index)
    const entry = findCompatibleSavedFormEntry(savedForms, item, index)
    if (entry) matchedForms.push([key, entry.form, entry.key])
  }
  return matchedForms
}
