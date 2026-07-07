const CASE_TO_COPY_KEY = {
  unauthorized: 'checkoutSessionInvalid',
  emptyCart: 'checkoutCartEmpty',
  noPaymentMethodId: 'checkoutChoosePaymentMethod',
  noPaymentMethod: 'checkoutChoosePaymentMethod',
  invalidBillingProfile: 'checkoutInvoiceProfileInvalid',
  buyerProfileIncomplete: 'checkoutDetailsInvalid',
  ownerProfileIncomplete: 'checkoutDetailsInvalid',
  ownerPhotoRequired: 'checkoutDetailsInvalid',
  invalidOwner: 'checkoutDetailsInvalid',
  noDeliveryLocation: 'checkoutDetailsInvalid',
  invalidDeliveryLocation: 'checkoutDetailsInvalid',
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

export function checkoutErrorMessage(err, copy = {}, fallback) {
  const info = checkoutErrorInfo(err)
  const safeFallback = fallback || copy.checkoutUnexpected || 'Something went wrong. Please try again.'

  if (info.isNetwork) return copy.checkoutNetwork || safeFallback
  if (info.case && CASE_TO_COPY_KEY[info.case]) return copy[CASE_TO_COPY_KEY[info.case]] || safeFallback
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

export function checkoutErrorInfo(err) {
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
    message,
    status,
    isNetwork: isNetworkError(err, message)
  }
}

function isNetworkError(err, message) {
  const haystack = [
    message,
    err?.name,
    err?.code,
    err?.cause?.code,
    err?.cause?.message
  ].filter(Boolean).join(' ').toLowerCase()

  return NETWORK_PATTERNS.some(pattern => haystack.includes(pattern))
}

function isRawErrorMessage(message) {
  return RAW_ERROR_PATTERNS.some(pattern => pattern.test(String(message)))
}

function firstText(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return ''
}
