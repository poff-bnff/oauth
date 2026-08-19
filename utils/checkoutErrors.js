const CASE_TO_COPY_KEY = {
  unauthorized: 'checkoutSessionInvalid',
  emptyCart: 'checkoutCartEmpty',
  noPaymentMethodId: 'checkoutChoosePaymentMethod',
  noPaymentMethod: 'checkoutChoosePaymentMethod',
  invalidBillingProfile: 'checkoutInvoiceProfileInvalid',
  // Each of these used to share one sentence — "check the item details" — which told the customer
  // nothing about whether to fix their profile, pick a pickup point or change a recipient. The
  // server already knows which item and which fields; %ITEM% and %MISSING% carry that through.
  buyerProfileIncomplete: 'checkoutBuyerProfileIncomplete',
  ownerProfileIncomplete: 'checkoutOwnerProfileIncomplete',
  ownerPhotoRequired: 'checkoutOwnerPhotoRequired',
  invalidOwner: 'checkoutInvalidOwner',
  noDeliveryLocation: 'checkoutNoDeliveryLocation',
  invalidDeliveryLocation: 'checkoutInvalidDeliveryLocation',
  productUnavailable: 'checkoutItemUnavailable',
  reservationSaveFailed: 'checkoutItemUnavailable',
  addFailed: 'checkoutBusy',
  cartUpdateFailed: 'cartUpdateFailed'
}

const NETWORK_PATTERNS = [
  'networkerror',
  'failed to fetch',
  'fetch failed',
  'load failed',
  '<no response>',
  'err_network',
  'econnreset',
  'etimedout',
  'eai_again',
  'enotfound'
]

const MESSAGE_TO_COPY_KEY = {
  'payment failed': 'checkoutPaymentFailed',
  'checkout failed to load': 'checkoutLoadFailed',
  'could not save invoice profile': 'checkoutInvoiceSaveFailed',
  'could not save profile': 'checkoutProfileSaveFailed',
  'too many requests': 'checkoutBusy',
  'too many new carts': 'checkoutBusy'
}

const RAW_ERROR_PATTERNS = [
  /^\[[A-Z]+\]/,
  /\bBad Request\b/i,
  /\bInternal Server Error\b/i,
  /\bFetchError\b/i,
  /\bstatusCode\b/i,
  /\bSQL\b/i,
  /\bduplicate key\b/i
]

// `options.items` are the cart items, used only to turn a productId into a title the customer
// recognises. Optional: without them the message degrades to "this item" rather than breaking.
export function checkoutErrorMessage (err, copy = {}, fallback, options = {}) {
  const info = checkoutErrorInfo(err)
  const safeFallback = fallback || copy.checkoutUnexpected || 'Something went wrong. Please try again.'

  if (info.isNetwork) return copy.checkoutNetwork || safeFallback
  if (info.case && CASE_TO_COPY_KEY[info.case]) {
    return fillErrorTokens(copy[CASE_TO_COPY_KEY[info.case]] || safeFallback, info, copy, options)
  }
  if (info.status === 401 || info.status === 403) return copy.checkoutSessionInvalid || safeFallback
  if (info.status === 408 || info.status === 504) return copy.checkoutNetwork || safeFallback
  if (info.status === 409) return copy.checkoutItemUnavailable || safeFallback
  if (info.status === 429 || info.status === 502 || info.status === 503) return copy.checkoutBusy || safeFallback
  if (info.status >= 500) return copy.checkoutUnexpected || safeFallback
  if (info.status >= 400) return safeFallback

  const messageKey = MESSAGE_TO_COPY_KEY[info.message.toLowerCase()]
  if (messageKey) return copy[messageKey] || safeFallback

  if (!info.message || isRawErrorMessage(info.message)) return safeFallback
  return info.message
}

export function checkoutErrorInfo (err) {
  const message = firstText(
    err?.data?.data?.case,
    err?.data?.case,
    err?.data?.statusMessage,
    err?.statusMessage,
    err?.message
  )
  const status = Number(
    err?.statusCode ||
    err?.status ||
    err?.response?.status ||
    err?.data?.statusCode ||
    err?.data?.status ||
    0
  )

  return {
    case: firstText(err?.data?.data?.case, err?.data?.case),
    // Carried through so a message can name the item and the fields rather than being generic.
    productId: err?.data?.data?.productId ?? err?.data?.productId ?? null,
    missing: err?.data?.data?.missing || err?.data?.missing || [],
    message,
    status,
    isNetwork: isNetworkError(err, message)
  }
}

// Raw Strapi field names are meaningless to a customer, so they are translated like any other copy.
const FIELD_COPY_KEYS = {
  email: 'fieldEmail',
  firstName: 'fieldFirstName',
  lastName: 'fieldLastName',
  picture: 'fieldPhoto'
}

export function fillErrorTokens (text, info, copy = {}, options = {}) {
  let out = String(text == null ? '' : text)

  if (out.includes('%ITEM%')) {
    out = out.split('%ITEM%').join(itemTitleFor(info.productId, options.items, copy))
  }

  if (out.includes('%MISSING%')) {
    const labels = (info.missing || [])
      .map(field => copy[FIELD_COPY_KEYS[field]] || field)
      .filter(Boolean)
    // An empty list would leave a dangling "missing: ." — fall back to the generic word.
    out = out.split('%MISSING%').join(labels.length ? labels.join(', ') : (copy.fieldSomeDetails || 'some details'))
  }

  return out
}

function itemTitleFor (productId, items, copy) {
  const match = (items || []).find(item => String(item.productId) === String(productId))
  const title = match && (typeof match.title === 'object' ? (match.title.et || match.title.en) : match.title)

  return title || copy.thisItem || 'this item'
}

function isNetworkError (err, message) {
  const haystack = [
    message,
    err?.name,
    err?.code,
    err?.cause?.code,
    err?.cause?.message
  ].filter(Boolean).join(' ').toLowerCase()

  return NETWORK_PATTERNS.some(pattern => haystack.includes(pattern))
}

function isRawErrorMessage (message) {
  return RAW_ERROR_PATTERNS.some(pattern => pattern.test(String(message)))
}

function firstText (...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return ''
}
