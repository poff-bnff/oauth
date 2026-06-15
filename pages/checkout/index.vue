<script setup>
import { useCheckoutCopy } from './composables/useCheckoutCopy.js'
import { useCheckoutSession } from './composables/useCheckoutSession.js'
import CheckoutSessionBanner from './components/CheckoutSessionBanner.vue'
import CheckoutItemStep from './components/CheckoutItemStep.vue'
import CheckoutInvoiceStep from './components/CheckoutInvoiceStep.vue'
import CheckoutPaymentStep from './components/CheckoutPaymentStep.vue'
import CheckoutProfileStep from './components/CheckoutProfileStep.vue'
import CheckoutOrderSummary from './components/CheckoutOrderSummary.vue'

// ── Auth ──────────────────────────────────────────────────────────────────────
const route = useRoute()
const runtime = useRuntimeConfig()
const tokenCookie = useCookie('checkout_token')
const token = ref(route.query.jwt || tokenCookie.value || '')
const locale = ref(route.query.locale || 'en')
const authHeaders = computed(() => ({ Authorization: `Bearer ${token.value}` }))

// ── Copy (i18n) ───────────────────────────────────────────────────────────────
const copy = useCheckoutCopy(locale)

// ── Core state ────────────────────────────────────────────────────────────────
// ── Transaction result (return from payment gateway) ─────────────────────────
const transactionResult = computed(() => {
  const r = route.query.result
  if (!r) return null
  if (String(r).toLowerCase().includes('successful')) return 'success'
  if (String(r).toLowerCase().includes('cancel')) return 'cancelled'
  return null
})
const orderSnapshot = ref(null)

const loading = ref(true)
const error = ref('')
const paying = ref(false)
const step = ref(1)
const profileDone = ref(false)
const context = ref(null)
const selectedBillingProfileId = ref(null)
const paymentMethodId = ref('')
const invoiceView = ref('list')
const invoiceFormType = ref('personal')
const invoiceFor = ref('me')
const savingInvoiceProfile = ref(false)
const saveAsInvoiceProfile = ref(true)
const invoiceFormSnapshot = ref('')
const openItemKey = ref(null)
const itemForms = reactive({})
const brokenImages = reactive({})

// ── Cart mutation queue ───────────────────────────────────────────────────────
// Serializes remove ops: rapid clicks enqueue behind the in-flight request so
// the server's mutex (strapi.js) never receives overlapping writes for this tab.
let cartOpQueue = Promise.resolve()
const removingComponentIds = ref(new Set())
function queueCartMutation (fn) {
  cartOpQueue = cartOpQueue.catch(() => {}).then(fn)
  return cartOpQueue
}

const invoiceForm = reactive({
  firstName: '',
  lastName: '',
  email: '',
  phone: '',
  country: 'Estonia',
  address: '',
  city: '',
  postalCode: '',
  companyName: '',
  registryCode: '',
  vatNumber: '',
  contactPerson: ''
})

// ── Derived from context ──────────────────────────────────────────────────────
const cart = computed(() => context.value?.cart || { items: [], total: 0 })
const profiles = computed(() => context.value?.businessProfiles || [])
const personalProfiles = computed(() => profiles.value.filter(p => !isOrganisationProfile(p)))
const organisationProfiles = computed(() => profiles.value.filter(p => isOrganisationProfile(p)))
const paymentMethodGroups = computed(() => {
  const methods = context.value?.paymentMethods || {}
  return [
    { label: copy.value.bankTransfer, methods: methods.banklinks || [] },
    { label: copy.value.cardPayment, methods: methods.cards || [] },
    { label: copy.value.otherPayments, methods: methods.other || [] },
    { label: copy.value.payLaterLabel, methods: methods.payLater || [] }
  ].filter(g => g.methods.length)
})
const vatAmount = computed(() => Number(cart.value.total || 0) * 24 / 124)
const selectedBillingProfile = computed(() => profiles.value.find(p => String(p.id) === String(selectedBillingProfileId.value)))
const isInvoiceFormVisible = computed(() => invoiceView.value === 'selected' || invoiceView.value === 'create')
const checkoutStepTitle = computed(() => {
  const total = stepTotal.value
  const items = cart.value.items || []
  const done = items.filter((item, i) => isItemComplete(item, i)).length
  if (step.value === 0) return `${copy.value.stepLabel} 1 / ${total} · ${copy.value.yourProfile}`
  if (step.value === 1) return `${copy.value.stepLabel} ${itemStepNo.value} / ${total} · ${done} of ${items.length} ${copy.value.complete}`
  if (step.value === 2) return `${copy.value.stepLabel} ${invoiceStepNo.value} / ${total} · ${isInvoiceFormVisible.value ? copy.value.taxDocument : copy.value.chooseSavedProfile}`
  return `${copy.value.stepLabel} ${payStepNo.value} / ${total} · ${copy.value.confirmPurchase}`
})
const shopBackUrl = computed(() => {
  const clean = cleanShopUrl(route.query.shop_url || route.query.cancel_url || route.query.return_url)
  if (clean) return clean
  const path = locale.value === 'et' ? '/shop' : `/${locale.value}/shop`
  return runtime.public.url?.includes('localhost') ? `http://localhost:4000${path}` : `https://poff.ee${path}`
})
const myPoffUrl = computed(() => {
  const urls = { en: 'https://poff.ee/en/mypoff/', ru: 'https://poff.ee/ru/moipoff/', et: 'https://poff.ee/minupoff/' }
  return urls[locale.value] || urls.et
})
const hasProfileStep = computed(() => {
  const p = context.value?.profile || {}
  return !(p.email && p.firstName && p.lastName && p.picture)
})

const stepTotal = computed(() => hasProfileStep.value ? 4 : 3)
const itemStepNo = computed(() => hasProfileStep.value ? 2 : 1)
const invoiceStepNo = computed(() => hasProfileStep.value ? 3 : 2)
const payStepNo = computed(() => hasProfileStep.value ? 4 : 3)

const maxStep = computed(() => {
  if (hasProfileStep.value && !profileDone.value) return 0
  if (!cart.value.items?.length) return 1
  if (!cart.value.items.every(isItemComplete)) return 1
  if (!selectedBillingProfileId.value) return 2
  return 3
})

// ── Session (state + derived computeds; actions stay here because they fetch) ─
const {
  sessionNow,
  touchingCartSession,
  sessionExpired,
  sessionWarningDismissed,
  sessionPreviewExpiresAt,
  sessionRemainingSeconds,
  sessionDisplay,
  sessionBannerTone,
  showSessionWarningModal,
  dismissSessionWarning
} = useCheckoutSession({ cart, route, runtime })

const sessionBannerText = computed(() => {
  if (sessionBannerTone.value === 'warning') return copy.value.sessionFinal
  if (sessionBannerTone.value === 'pink') return copy.value.sessionHurry
  if (sessionBannerTone.value === 'yellow') return copy.value.sessionFewMinutes
  return copy.value.holdCart
})

// ── Utility functions ─────────────────────────────────────────────────────────
function formatPrice (value) {
  return `${Number(value || 0).toFixed(2)} €`
}

function isOrganisationProfile (profile) {
  return Boolean(profile?.org_name || profile?.reg_code || profile?.vat_code || profile?.organisation)
}

function safeBackUrl (value) {
  const url = Array.isArray(value) ? value[0] : value
  if (!url || typeof url !== 'string') return ''
  if (url.startsWith('/')) return url
  try {
    const parsed = new URL(url)
    return ['http:', 'https:'].includes(parsed.protocol) ? parsed.toString() : ''
  } catch { return '' }
}

function checkoutRedirectUri () {
  const redirect = new URL(`${runtime.public.url}/checkout`)
  for (const [key, value] of Object.entries(route.query)) {
    if (key === 'jwt') continue
    const entry = Array.isArray(value) ? value[0] : value
    if (entry !== undefined && entry !== null && entry !== '') redirect.searchParams.set(key, entry)
  }
  redirect.searchParams.set('locale', locale.value)
  redirect.searchParams.set('jwt', '')
  return redirect.toString()
}

function checkoutLoginRedirectUri () {
  const nextUrl = checkoutRedirectUri()
  const shopUrl = cleanShopUrl(route.query.shop_url)
  if (!shopUrl) return nextUrl

  try {
    const claimUrl = new URL('/shop/cart/claim', shopUrl)
    claimUrl.searchParams.set('next', nextUrl)
    return claimUrl.toString()
  } catch {
    return nextUrl
  }
}

function itemKey (item, index = 0) {
  return `${item.productId}-${item.index ?? index}`
}

function ensureItemForm (item, index = 0) {
  const key = itemKey(item, index)
  if (!itemForms[key]) {
    itemForms[key] = {
      pickupLocationId: '',
      ownerMode: 'me',
      firstName: '',
      lastName: '',
      email: '',
      photo: null,
      photoName: '',
      photoError: '',
      sendEmail: true
    }
  }
  return itemForms[key]
}

function isGiftOwnerComplete (form) {
  return !!(form.firstName.trim() && form.lastName.trim() &&
    /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(form.email.trim()) && form.photo)
}

function isItemComplete (item, index) {
  const form = ensureItemForm(item, index)
  if (item.pickupLocations?.length && !form.pickupLocationId) return false
  if (item.transferable && form.ownerMode === 'gift') return isGiftOwnerComplete(form)
  return true
}

function cartSignature (items = []) {
  return items.map((item, index) => `${item.productId || item.categoryId || 'item'}:${item.index ?? index}`).join('|')
}

function fillInvoiceFormFromProfile (profile) {
  const address = profile?.address || {}
  Object.assign(invoiceForm, {
    firstName: profile?.firstName || '',
    lastName: profile?.lastName || '',
    email: profile?.email_for_invoice || '',
    phone: profile?.phone_nr || '',
    country: address.add_country || 'Estonia',
    address: address.street_name || '',
    city: address.add_municipality || '',
    postalCode: address.postal_code || '',
    companyName: profile?.org_name || '',
    registryCode: profile?.reg_code || '',
    vatNumber: profile?.vat_code || '',
    contactPerson: profile?.firstNameLastName || ''
  })
}

function snapshotInvoiceForm () {
  invoiceFormSnapshot.value = JSON.stringify(invoiceProfileBody())
}

function invoiceProfileBody () {
  const isCompany = invoiceFormType.value === 'organisation'
  return {
    firstName: isCompany ? null : invoiceForm.firstName.trim(),
    lastName: isCompany ? null : invoiceForm.lastName.trim(),
    firstNameLastName: isCompany
      ? invoiceForm.contactPerson.trim()
      : [invoiceForm.firstName, invoiceForm.lastName].filter(Boolean).join(' ').trim(),
    org_name: isCompany ? invoiceForm.companyName.trim() : null,
    reg_code: isCompany ? invoiceForm.registryCode.trim() : null,
    vat_code: isCompany ? invoiceForm.vatNumber.trim() : null,
    email_for_invoice: invoiceForm.email.trim(),
    phone_nr: invoiceForm.phone.trim(),
    saved_for_reuse: saveAsInvoiceProfile.value,
    address: {
      street_name: isCompany ? invoiceForm.address.trim() : '',
      add_municipality: isCompany ? invoiceForm.city.trim() : '',
      postal_code: isCompany ? invoiceForm.postalCode.trim() : '',
      add_country: isCompany ? invoiceForm.country.trim() : ''
    }
  }
}

// ── Context & session actions ─────────────────────────────────────────────────
let sessionClock = null
let sessionSyncClock = null
let lastCartTouchAt = 0
let sessionExpiredRefreshPending = false

function openFirstIncompleteItem () {
  const items = cart.value.items || []
  const incompleteIndex = items.findIndex((item, i) => !isItemComplete(item, i))
  if (incompleteIndex >= 0) { openItemKey.value = itemKey(items[incompleteIndex], incompleteIndex); return }
  const firstConfigurableIndex = items.findIndex(item => !!(item.pickupLocations?.length || item.transferable))
  openItemKey.value = firstConfigurableIndex >= 0 ? itemKey(items[firstConfigurableIndex], firstConfigurableIndex) : null
}

function openNextIncompleteItem () {
  if (step.value !== 1) return
  const items = cart.value.items || []
  const openIndex = items.findIndex((item, i) => itemKey(item, i) === openItemKey.value)
  if (openIndex < 0 || !isItemComplete(items[openIndex], openIndex)) return
  const nextIndex = items.findIndex((item, i) => !isItemComplete(item, i))
  if (nextIndex >= 0) openItemKey.value = itemKey(items[nextIndex], nextIndex)
}

function applyCheckoutContext (nextContext, options = {}) {
  const previousSignature = cartSignature(cart.value.items || [])
  context.value = nextContext
  const nextItems = cart.value.items || []
  const nextSignature = cartSignature(nextItems)

  sessionNow.value = Date.now()
  if (nextItems.length && !sessionPreviewExpiresAt.value) {
    sessionExpired.value = false
    if (sessionRemainingSeconds.value > 30) sessionWarningDismissed.value = false
  }

  for (const [index, item] of nextItems.entries()) ensureItemForm(item, index)

  const cartChanged = previousSignature !== nextSignature
  if (cartChanged || options.openIncomplete) {
    openFirstIncompleteItem()
    if (step.value > 1 && !nextItems.every(isItemComplete)) step.value = 1
  }

  // If profile step is needed and we haven't done it yet, park on step 0.
  if (hasProfileStep.value && !profileDone.value && step.value >= 1) {
    step.value = 0
  }
}

async function refreshContext () {
  loading.value = true
  error.value = ''
  sessionExpiredRefreshPending = false
  try {
    if (route.query.jwt) { token.value = route.query.jwt; tokenCookie.value = token.value }

    if (transactionResult.value === 'success') {
      try {
        const saved = sessionStorage.getItem('poff_order_summary')
        if (saved) orderSnapshot.value = JSON.parse(saved)
      } catch { /* sessionStorage unavailable */ }
      // Remove result + any other noise from the address bar so a page refresh
      // doesn't replay the success view. Keep locale + shop_url.
      try {
        const clean = new URL(window.location.href)
        clean.searchParams.delete('result')
        clean.searchParams.delete('jwt')
        window.history.replaceState({}, '', clean.toString())
      } catch { /* SSR / no window */ }
      return
    }

    if (!token.value) {
      await navigateTo(`/?redirect_uri=${encodeURIComponent(checkoutLoginRedirectUri())}&locale=${locale.value}`, { external: false })
      return
    }
    const nextContext = await $fetch(`/api/checkout/context?locale=${encodeURIComponent(locale.value)}`, { headers: authHeaders.value })
    applyCheckoutContext(nextContext, { openIncomplete: true })
    if (!selectedBillingProfileId.value && profiles.value.length === 1) selectedBillingProfileId.value = profiles.value[0].id
    if (transactionResult.value === 'cancelled') error.value = copy.value.paymentCancelledText
  } catch (err) {
    error.value = err?.data?.statusMessage || err?.message || 'Checkout failed to load'
  } finally {
    loading.value = false
  }
}

async function syncCheckoutContext () {
  if (!token.value || loading.value || touchingCartSession.value || sessionExpired.value) return
  try {
    const nextContext = await $fetch(`/api/checkout/context?locale=${encodeURIComponent(locale.value)}`, { headers: authHeaders.value })
    applyCheckoutContext(nextContext)
  } catch { /* silent — never interrupt checkout UI */ }
}

async function touchCartSession (force = false) {
  if (!token.value || touchingCartSession.value || !cart.value?.items?.length) return null
  if (sessionRemainingSeconds.value <= 0) return null
  const now = Date.now()
  if (!force && now - lastCartTouchAt < 10000) return null
  lastCartTouchAt = now
  touchingCartSession.value = true
  try {
    const touchedCart = await $fetch('/api/cart/touch', {
      method: 'POST',
      headers: { ...authHeaders.value, 'Content-Type': 'application/json' },
      body: { locale: locale.value }
    })
    applyCheckoutContext({ ...(context.value || {}), cart: touchedCart || { items: [], total: 0 } })
    sessionExpired.value = false
    sessionWarningDismissed.value = false
    return touchedCart
  } catch (err) {
    if (err?.statusCode === 404 || err?.statusCode === 409) await refreshContext()
    return null
  } finally {
    touchingCartSession.value = false
  }
}

function handleCheckoutActivity () { touchCartSession() }

function startSessionClock () {
  if (sessionClock) clearInterval(sessionClock)
  sessionClock = setInterval(() => {
    sessionNow.value = Date.now()
    if (cart.value?.items?.length && sessionRemainingSeconds.value <= 0 && !sessionExpiredRefreshPending) {
      sessionExpiredRefreshPending = true
      sessionExpired.value = true
      if (!sessionPreviewExpiresAt.value) refreshContext()
    }
  }, 1000)
}

function startCheckoutSync () {
  if (sessionSyncClock) clearInterval(sessionSyncClock)
  sessionSyncClock = setInterval(syncCheckoutContext, 15000)
}

async function resumeSession () {
  sessionPreviewExpiresAt.value = null
  await touchCartSession(true)
}

// ── Invoice / billing profile actions ────────────────────────────────────────
function selectProfile (profile) {
  selectedBillingProfileId.value = profile.id
  invoiceFormType.value = isOrganisationProfile(profile) ? 'organisation' : 'personal'
  invoiceFor.value = 'me'
  saveAsInvoiceProfile.value = true
  fillInvoiceFormFromProfile(profile)
  snapshotInvoiceForm()
  invoiceView.value = 'selected'
}

function selectInvoiceFor (value) {
  invoiceFor.value = value
  error.value = ''
  if (value === 'someone') {
    selectedBillingProfileId.value = null
    startInvoiceForm('personal', 'someone') // resets saveAsInvoiceProfile → true
    saveAsInvoiceProfile.value = false // override: someone-else profile must NOT auto-save
    return
  }
  invoiceView.value = selectedBillingProfileId.value ? 'selected' : 'list'
  if (!selectedBillingProfileId.value && profiles.value.length === 1) selectedBillingProfileId.value = profiles.value[0].id
}

function startInvoiceForm (type, target = invoiceFor.value) {
  invoiceFor.value = target
  invoiceFormType.value = type
  invoiceView.value = 'create'
  selectedBillingProfileId.value = null
  saveAsInvoiceProfile.value = true
  const profile = context.value?.profile || {}
  Object.assign(invoiceForm, {
    firstName: target === 'me' ? profile.firstName || '' : '',
    lastName: target === 'me' ? profile.lastName || '' : '',
    email: target === 'me' ? profile.email || context.value?.user?.email || '' : '',
    phone: target === 'me' ? profile.phoneNr || '' : '',
    country: 'Estonia',
    address: '',
    city: '',
    postalCode: '',
    companyName: '',
    registryCode: '',
    vatNumber: '',
    contactPerson: ''
  })
  invoiceFormSnapshot.value = ''
}

async function saveInvoiceProfile (options = {}) {
  savingInvoiceProfile.value = true
  const body = invoiceProfileBody()
  try {
    const created = await $fetch('/api/business-profiles', {
      method: 'POST',
      headers: { ...authHeaders.value, 'Content-Type': 'application/json' },
      body
    })
    selectedBillingProfileId.value = created.id
    invoiceView.value = 'selected'
    await refreshContext()
    if (options.continueToPayment) nextFromInvoice()
  } catch (err) {
    error.value = err?.data?.statusMessage || err?.message || 'Could not save invoice profile'
  } finally {
    savingInvoiceProfile.value = false
  }
}

async function saveSelectedProfile (options = {}) {
  if (!selectedBillingProfileId.value) return nextFromInvoice()
  const body = invoiceProfileBody()
  if (JSON.stringify(body) === invoiceFormSnapshot.value) { if (options.continueToPayment) nextFromInvoice(); return }
  savingInvoiceProfile.value = true
  try {
    await $fetch(`/api/business-profiles/${selectedBillingProfileId.value}`, {
      method: 'PUT',
      headers: { ...authHeaders.value, 'Content-Type': 'application/json' },
      body
    })
    await refreshContext()
    snapshotInvoiceForm()
    if (options.continueToPayment) nextFromInvoice()
  } catch (err) {
    error.value = err?.data?.statusMessage || err?.message || 'Could not save invoice profile'
  } finally {
    savingInvoiceProfile.value = false
  }
}

function returnToInvoiceList () {
  invoiceView.value = 'list'
  selectedBillingProfileId.value = null
  invoiceFor.value = 'me'
}

// ── Navigation ────────────────────────────────────────────────────────────────
function nextFromInvoice () {
  if (!selectedBillingProfileId.value) { error.value = copy.value.chooseInvoiceProfile; return }
  error.value = ''
  step.value = 3
}

function goStep (targetStep) {
  if (targetStep <= maxStep.value) step.value = targetStep
}

// ── Payment ───────────────────────────────────────────────────────────────────
function cleanShopUrl (raw) {
  const url = safeBackUrl(raw)
  if (!url) return ''
  try {
    const parsed = new URL(url)
    parsed.searchParams.delete('result')
    return parsed.toString()
  } catch { return url }
}

function buildPaymentReturnUrl () {
  const base = new URL(`${runtime.public.url}/checkout`)
  base.searchParams.set('locale', locale.value)
  const shop = cleanShopUrl(route.query.shop_url || route.query.cancel_url || route.query.return_url)
  if (shop) base.searchParams.set('shop_url', shop)
  return base.toString()
}

function removeItem ({ item }) {
  const componentId = item.componentId ?? null
  error.value = ''
  // Mark this row as in-flight so its button shows a spinner and is disabled.
  removingComponentIds.value = new Set([...removingComponentIds.value, componentId])
  queueCartMutation(async () => {
    try {
      await $fetch('/api/cart/items/remove', {
        method: 'POST',
        headers: { ...authHeaders.value, 'Content-Type': 'application/json' },
        // keepalive: survive a full-page navigation away (e.g. user goes back to shop
        // while the spinner is showing). Server completes the remove; the fresh
        // refreshContext() on the next checkout mount will reflect the result.
        keepalive: true,
        body: { componentId, productId: item.productId }
      })
      await refreshContext()
    } catch (err) {
      error.value = err?.data?.statusMessage || err?.message || 'Could not remove item'
    } finally {
      removingComponentIds.value = new Set([...removingComponentIds.value].filter(id => id !== componentId))
    }
  })
}

async function pay () {
  if (!paymentMethodId.value) return
  paying.value = true
  error.value = ''
  try {
    const items = cart.value.items.map((item, index) => {
      const form = ensureItemForm(item, index)
      return {
        productId: item.productId,
        index: item.index,
        pickupLocationId: form.pickupLocationId || null,
        owner: {
          mode: item.transferable && form.ownerMode === 'gift' ? 'gift' : 'me',
          firstName: form.firstName,
          lastName: form.lastName,
          email: form.email,
          photo: form.photo,
          hasPhoto: !!form.photo,
          sendEmail: form.sendEmail
        }
      }
    })
    const result = await $fetch('/api/checkout/pay', {
      method: 'POST',
      headers: { ...authHeaders.value, 'Content-Type': 'application/json' },
      body: {
        paymentMethodId: paymentMethodId.value,
        billingProfileId: selectedBillingProfileId.value,
        locale: locale.value,
        items,
        return_url: buildPaymentReturnUrl(),
        cancel_url: buildPaymentReturnUrl()
      }
    })
    if (result?.url) {
      try {
        const selectedMethod = paymentMethodGroups.value.flatMap(g => g.methods).find(m => m.id === paymentMethodId.value)
        const invoiceEmail = selectedBillingProfile.value?.email || invoiceForm.email || ''
        const summaryItems = (cart.value.items || []).map((item, index) => {
          const form = ensureItemForm(item, index)
          const location = (item.pickupLocations || []).find(l => String(l.id) === String(form.pickupLocationId))
          const isGift = item.transferable && form.ownerMode === 'gift'
          return {
            productId: item.productId,
            title: item.title,
            price: item.price,
            imageUrl: item.imageUrl,
            pickupName: location?.name || null,
            giftName: isGift ? form.firstName.trim() : null
          }
        })
        sessionStorage.setItem('poff_order_summary', JSON.stringify({
          items: summaryItems,
          total: cart.value.total || 0,
          orderId: result.orderId,
          orderNo: result.orderId,
          paymentLabel: selectedMethod?.name || '',
          invoiceEmail,
          hasPickup: summaryItems.some(it => it.pickupName)
        }))
      } catch { /* sessionStorage unavailable — success page will show generic message */ }
      await navigateTo(result.url, { external: true })
    }
  } catch (err) {
    error.value = err?.data?.data?.case || err?.data?.statusMessage || err?.message || 'Payment failed'
  } finally {
    paying.value = false
  }
}

// ── Lifecycle ─────────────────────────────────────────────────────────────────
onMounted(() => {
  startSessionClock()
  startCheckoutSync()
  refreshContext()
})
onBeforeUnmount(() => {
  if (sessionClock) clearInterval(sessionClock)
  if (sessionSyncClock) clearInterval(sessionSyncClock)
})

const completedItemCount = computed(() => (cart.value.items || []).filter((item, i) => isItemComplete(item, i)).length)
watch(completedItemCount, openNextIncompleteItem)
watch(sessionRemainingSeconds, (seconds) => {
  if (seconds > 30) sessionWarningDismissed.value = false
})
</script>

<template>
  <div class="checkout-page">
    <div v-if="loading" class="loading">
      Loading checkout...
    </div>
    <main
      v-else
      class="checkout-wrap"
      @click="handleCheckoutActivity"
      @input="handleCheckoutActivity"
      @change="handleCheckoutActivity"
      @keydown="handleCheckoutActivity"
    >
      <a class="back-shop" :href="shopBackUrl">&larr; {{ copy.backToShop }}</a>
      <template v-if="transactionResult !== 'success'">
        <p class="page-kicker">
          Checkout
        </p>
        <h1 class="page-title">
          {{ copy.completeOrder }}
        </h1>

        <CheckoutSessionBanner
          :tone="sessionBannerTone"
          :banner-text="sessionBannerText"
          :display="sessionDisplay"
          :copy="copy"
        />
      </template>

      <template v-if="transactionResult === 'success'">
        <div class="order-complete">
          <div class="order-complete-head">
            <div class="order-complete-check" aria-hidden="true">
              &#10003;
            </div>
            <p class="order-complete-kicker">
              {{ copy.paymentReceived }}
            </p>
            <h2 class="order-complete-title">
              {{ copy.orderConfirmedHeading }}
            </h2>
            <p v-if="orderSnapshot?.orderNo" class="order-complete-no">
              {{ copy.order }} <span>#{{ orderSnapshot.orderNo }}</span>
            </p>
          </div>

          <div class="order-complete-notice">
            <svg
              width="20"
              height="20"
              viewBox="0 0 24 24"
              fill="none"
              stroke="#f5a623"
              stroke-width="1.8"
              stroke-linecap="round"
              stroke-linejoin="round"
              aria-hidden="true"
            >
              <rect x="3" y="5" width="18" height="14" rx="1" />
              <polyline points="3 6 12 13 21 6" />
            </svg>
            <p>
              {{ copy.invoiceOnWay }}<template v-if="orderSnapshot?.invoiceEmail">
                {{ ` ${copy.invoiceOnWayTo} ` }}<strong>{{ orderSnapshot.invoiceEmail }}</strong>
              </template>.
            </p>
          </div>

          <div class="order-complete-summary">
            <div class="order-complete-summary-head">
              {{ copy.orderSummary }}
            </div>
            <div class="order-complete-items">
              <div v-for="(item, i) in (orderSnapshot?.items || [])" :key="`${item.productId}-${i}`" class="order-complete-item">
                <div class="order-complete-thumb">
                  <img v-if="item.imageUrl" :src="item.imageUrl" :alt="item.title">
                  <span v-else class="order-complete-thumb-placeholder" aria-hidden="true" />
                </div>
                <div class="order-complete-item-copy">
                  <span class="order-complete-item-name">{{ item.title }}</span>
                  <span class="order-complete-item-meta">
                    {{ item.pickupName ? `${copy.pickup} · ${item.pickupName}` : copy.deliveredByEmail }}<template v-if="item.giftName"> · {{ copy.giftTo }} {{ item.giftName }}</template>
                  </span>
                </div>
                <span class="order-complete-item-price">{{ formatPrice(item.price) }}</span>
              </div>
            </div>
            <div class="order-complete-totals">
              <div class="order-complete-paid">
                <span>{{ copy.paidWith }}</span><span>{{ orderSnapshot?.paymentLabel || '—' }}</span>
              </div>
              <div class="order-complete-total">
                <span>{{ copy.totalPaid }}</span><strong>{{ formatPrice(orderSnapshot?.total) }}</strong>
              </div>
            </div>
          </div>

          <a class="order-complete-cta" :href="myPoffUrl" target="_blank" rel="noopener noreferrer">{{ copy.goToMyPoff }} &rarr;</a>
          <p class="order-complete-cta-url">
            {{ myPoffUrl }}
          </p>

          <div class="order-complete-restart">
            <a :href="shopBackUrl">{{ copy.startNewOrder }}</a>
          </div>

          <div class="order-complete-foot">
            {{ copy.questionsAbout }} <a href="mailto:shop@poff.ee">shop@poff.ee</a>
          </div>
        </div>
      </template>

      <template v-else>
        <div v-if="error" class="error">
          {{ error }}
        </div>
        <div v-if="!cart.items.length" class="empty">
          {{ copy.empty }}
        </div>

        <div v-if="cart.items.length" class="checkout-grid">
          <section class="checkout-main">
            <nav class="steps">
              <button
                v-if="hasProfileStep"
                :class="{ active: step === 0, done: profileDone }"
                type="button"
                :disabled="step === 0"
                @click="goStep(0)"
              >
                1. {{ copy.yourProfile }}
              </button>
              <button :class="{ active: step === 1, done: step > 1 }" type="button" :disabled="maxStep < 1" @click="goStep(1)">
                {{ itemStepNo }}. {{ copy.details }}
              </button>
              <button :class="{ active: step === 2, done: step > 2 }" type="button" :disabled="maxStep < 2" @click="goStep(2)">
                {{ invoiceStepNo }}. {{ copy.invoice }}
              </button>
              <button :class="{ active: step === 3 }" type="button" :disabled="maxStep < 3" @click="goStep(3)">
                {{ payStepNo }}. {{ copy.payStep }}
              </button>
            </nav>

            <CheckoutProfileStep
              v-if="step === 0"
              :copy="copy"
              :auth-headers="authHeaders"
              :profile="context?.profile || {}"
              @done="profileDone = true; step = 1"
            />

            <CheckoutItemStep
              v-if="step === 1"
              :cart="cart"
              :item-forms="itemForms"
              :open-item-key="openItemKey"
              :broken-images="brokenImages"
              :removing-component-ids="removingComponentIds"
              :locale="locale"
              :copy="copy"
              @update:open-item-key="openItemKey = $event"
              @error="error = $event"
              @continue="step = 2"
              @remove="removeItem"
            />

            <CheckoutInvoiceStep
              v-if="step === 2"
              :copy="copy"
              :invoice-view="invoiceView"
              :invoice-form="invoiceForm"
              :invoice-form-type="invoiceFormType"
              :invoice-for="invoiceFor"
              :personal-profiles="personalProfiles"
              :organisation-profiles="organisationProfiles"
              :selected-billing-profile="selectedBillingProfile"
              :save-as-invoice-profile="saveAsInvoiceProfile"
              :saving-invoice-profile="savingInvoiceProfile"
              @select-profile="selectProfile"
              @select-invoice-for="selectInvoiceFor"
              @start-form="startInvoiceForm"
              @return-to-list="returnToInvoiceList"
              @save-new="saveInvoiceProfile"
              @save-selected="saveSelectedProfile"
              @update:save-as-invoice-profile="saveAsInvoiceProfile = $event"
              @update:invoice-form-type="invoiceFormType = $event"
              @back="step = 1"
            />

            <CheckoutPaymentStep
              v-if="step === 3"
              :copy="copy"
              :cart="cart"
              :selected-billing-profile="selectedBillingProfile"
              :payment-method-groups="paymentMethodGroups"
              :payment-method-id="paymentMethodId"
              :paying="paying"
              @update:payment-method-id="paymentMethodId = $event"
              @pay="pay"
              @back="step = 2"
            />
          </section>

          <CheckoutOrderSummary :cart="cart" :vat-amount="vatAmount" :copy="copy" />
        </div>
      </template>
    </main>

    <!-- Session expiry warning modal (outside <main> to avoid stacking context issues) -->
    <div v-if="showSessionWarningModal || sessionExpired" class="session-modal-layer" @click.stop>
      <section class="session-modal" :class="{ expired: sessionExpired }" role="dialog" aria-modal="true">
        <div class="session-modal-icon" aria-hidden="true">
          <svg v-if="sessionExpired" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9" /><path d="m9 9 6 6M15 9l-6 6" /></svg>
          <svg v-else viewBox="0 0 24 24"><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></svg>
        </div>
        <h2>{{ sessionExpired ? copy.sessionExpiredTitle : copy.sessionAboutToExpire }}</h2>
        <p v-if="sessionExpired">
          {{ copy.sessionExpiredText }}
        </p>
        <p v-else>
          {{ copy.sessionClearedIn }}
        </p>
        <strong v-if="!sessionExpired" class="session-modal-time">{{ sessionDisplay }}</strong>
        <a v-if="sessionExpired" class="primary session-modal-button" :href="shopBackUrl">{{ copy.backToShop }}</a>
        <button v-else class="primary session-modal-button" type="button" :disabled="touchingCartSession" @click="resumeSession">
          {{ touchingCartSession ? '...' : copy.keepCart }}
        </button>
        <button v-if="!sessionExpired" class="session-dismiss" type="button" @click="dismissSessionWarning">
          {{ copy.dismiss }}
        </button>
      </section>
    </div>
  </div>
</template>

<style>
@import './checkout.css';
</style>
