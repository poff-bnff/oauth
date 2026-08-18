import { expect, test } from '@playwright/test'
import { makePng } from './makePng.js'

// Browser-level cover for the crop step. Mirrors checkout-progress.spec.js: the checkout API is
// mocked in the browser, so this needs no Strapi, no login and no real cart.
//
// The /api/config/photo-rules call is deliberately NOT mocked in most tests — it fails against the
// dev server and the code falls back to its defaults, which is exactly the production behaviour
// while the Strapi endpoint is undeployed.

const buyerProfileWithoutPicture = {
  email: 'buyer@example.test',
  firstName: 'Test',
  lastName: 'Buyer'
  // no `picture`, which is what makes the checkout show the profile step
}

const invoiceProfile = {
  id: 77,
  firstName: 'Test',
  lastName: 'Buyer',
  firstNameLastName: 'Test Buyer',
  email_for_invoice: 'buyer@example.test',
  phone_nr: '+3725555555',
  address: {}
}

function cartItem ({ componentId, productId, title, locationId, transferable = false }) {
  return {
    componentId,
    productId,
    categoryId: 36,
    index: 0,
    title,
    price: 95,
    imageUrl: '',
    transferable,
    pickupLocations: [{ id: locationId, name: `Pickup ${locationId}`, raw: { address: 'Tallinn' } }]
  }
}

function checkoutContext (items, profile) {
  return {
    user: { id: 1, email: buyerProfileWithoutPicture.email },
    profile,
    businessProfiles: [invoiceProfile],
    paymentMethods: { banklinks: [{ id: 'bank-test', name: 'Test bank', logo: '' }], cards: [], other: [], payLater: [] },
    cart: { id: 10, items, total: items.reduce((sum, item) => sum + item.price, 0), secondsRemaining: 1800 }
  }
}

async function prepareCheckoutPage ({ browser, items, profile = buyerProfileWithoutPicture, rules = null }) {
  const context = await browser.newContext()
  await context.addCookies([{ name: 'checkout_token', value: 'integration-token', domain: 'localhost', path: '/' }])

  const page = await context.newPage()
  const profileRequests = []

  await page.route('**/api/checkout/context?**', route => route.fulfill({ json: checkoutContext(items, profile) }))
  await page.route('**/api/cart/touch', route => route.fulfill({ json: checkoutContext(items, profile).cart }))
  await page.route('**/api/business-profiles/**', route => route.fulfill({ json: invoiceProfile }))

  if (rules) {
    await page.route('**/api/config/photo-rules', route => route.fulfill({ json: rules }))
  }

  await page.route('**/api/checkout/profile', async (route) => {
    profileRequests.push(route.request().postDataJSON())
    await route.fulfill({ json: { ok: true } })
  })

  return { context, page, profileRequests }
}

const checkoutUrl = () => '/checkout?locale=en&shop_url=http%3A%2F%2Flocalhost%3A4000%2Fen%2Fshop'

// Measures a data URL in the page, so assertions are about the real decoded pixels.
function measure (page, dataUrl) {
  return page.evaluate(src => new Promise((resolve) => {
    const img = new Image()
    img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight })
    img.onerror = () => resolve(null)
    img.src = src
  }), dataUrl)
}

async function choosePhoto (page, { width, height, name = 'portrait.png' }) {
  await page.locator('.photo-upload input[type="file"]').setInputFiles({
    name,
    mimeType: 'image/png',
    buffer: makePng(width, height)
  })
}

test('a portrait photo must be cropped to a square before it can be used', async ({ browser }) => {
  const { context, page, profileRequests } = await prepareCheckoutPage({
    browser,
    items: [cartItem({ componentId: 1001, productId: 7001, title: 'Crop pass', locationId: 501 })]
  })

  await page.goto(checkoutUrl())
  await expect(page.getByRole('heading', { name: 'Your profile' })).toBeVisible()

  // 900x1200 portrait: the shape the server currently centre-crops without asking.
  await choosePhoto(page, { width: 900, height: 1200 })

  await expect(page.getByRole('dialog')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Use this photo' })).toBeVisible()
  await page.getByRole('button', { name: 'Use this photo' }).click()
  await expect(page.getByRole('dialog')).toBeHidden()

  // The preview now shows the cropped square, not the portrait original.
  const previewSrc = await page.locator('.photo-preview img').getAttribute('src')
  const preview = await measure(page, previewSrc)
  expect(preview.width).toBe(preview.height)

  await page.getByRole('button', { name: /Save/ }).click()
  await expect.poll(() => profileRequests.length).toBeGreaterThan(0)

  const uploaded = await measure(page, profileRequests[0].photo.data)
  expect(uploaded.width).toBe(uploaded.height)
  expect(uploaded.width).toBeLessThanOrEqual(1600)
  expect(uploaded.width).toBeGreaterThanOrEqual(600)
  // A PNG stays a PNG so transparency survives; only other formats are re-encoded to JPEG.
  // The extension-rewrite path is covered by the unit tests for croppedFileName.
  expect(profileRequests[0].photo.name).toBe('portrait.png')
  expect(profileRequests[0].photo.data.startsWith('data:image/png;base64,')).toBe(true)

  await context.close()
})

test('an image below the minimum is refused and never reaches the cropper', async ({ browser }) => {
  const { context, page } = await prepareCheckoutPage({
    browser,
    items: [cartItem({ componentId: 1002, productId: 7002, title: 'Small pass', locationId: 502 })]
  })

  await page.goto(checkoutUrl())
  await expect(page.getByRole('heading', { name: 'Your profile' })).toBeVisible()

  await choosePhoto(page, { width: 400, height: 400, name: 'tiny.png' })

  await expect(page.locator('.photo-error')).toBeVisible()
  await expect(page.getByRole('dialog')).toBeHidden()

  await context.close()
})

test('cancelling the crop leaves no photo, and the same file can be chosen again', async ({ browser }) => {
  const { context, page } = await prepareCheckoutPage({
    browser,
    items: [cartItem({ componentId: 1003, productId: 7003, title: 'Cancel pass', locationId: 503 })]
  })

  await page.goto(checkoutUrl())
  await expect(page.getByRole('heading', { name: 'Your profile' })).toBeVisible()

  await choosePhoto(page, { width: 900, height: 900 })
  await page.getByRole('button', { name: 'Choose another' }).click()
  await expect(page.getByRole('dialog')).toBeHidden()
  await expect(page.locator('.photo-preview img')).toHaveCount(0)

  // Re-selecting the SAME file must still fire `change`; the input is cleared for exactly this.
  await choosePhoto(page, { width: 900, height: 900 })
  await expect(page.getByRole('dialog')).toBeVisible()

  await context.close()
})

test('rules served by the endpoint override the built-in defaults', async ({ browser }) => {
  const { context, page } = await prepareCheckoutPage({
    browser,
    items: [cartItem({ componentId: 1004, productId: 7004, title: 'Rules pass', locationId: 504 })],
    rules: { minSourceWidth: 1000, minSourceHeight: 1000, maxOutputSize: 800, minOutputSize: 400, maxFileBytes: 5242880, aspectRatio: 1 }
  })

  await page.goto(checkoutUrl())
  await expect(page.getByRole('heading', { name: 'Your profile' })).toBeVisible()

  // 900x900 passes the default 600 minimum but fails the endpoint's 1000.
  await choosePhoto(page, { width: 900, height: 900 })
  await expect(page.locator('.photo-error')).toBeVisible()
  await expect(page.getByRole('dialog')).toBeHidden()

  await context.close()
})

// The riskiest path in the whole feature. Gift photos are stripped from the sessionStorage progress
// snapshot and kept in IndexedDB instead, so a reload restores from there. If the CROPPED image is
// not written back to that store, a reload silently resurrects the uncropped original and nobody
// notices until a pass is printed with the wrong framing.
test('a reload restores the CROPPED gift photo, not the original', async ({ browser }) => {
  const { context, page } = await prepareCheckoutPage({
    browser,
    items: [cartItem({ componentId: 4001, productId: 9101, title: 'Gift pass', locationId: 801, transferable: true })],
    // A complete profile, so the checkout opens on the item step rather than the profile step.
    profile: { ...buyerProfileWithoutPicture, picture: 'https://assets.example.test/buyer.jpg' }
  })

  await page.goto(checkoutUrl())
  await page.getByRole('button', { name: /Pickup 801/ }).click()
  await page.getByRole('button', { name: 'As a gift' }).click()
  await page.getByLabel('First name *').fill('Gift')
  await page.getByLabel('Last name *').fill('Person')
  await page.getByLabel('Email *').fill('gift@example.test')

  // Portrait source, so "square" is proof the crop survived rather than a coincidence.
  await choosePhoto(page, { width: 900, height: 1200, name: 'gift.png' })
  await expect(page.getByRole('dialog')).toBeVisible()
  await page.getByRole('button', { name: 'Use this photo' }).click()
  await expect(page.getByRole('dialog')).toBeHidden()

  const beforeReload = await measure(page, await page.locator('.photo-preview img').getAttribute('src'))
  expect(beforeReload.width).toBe(beforeReload.height)

  await page.reload()
  await expect(page.getByRole('button', { name: /Gift pass/ })).toBeVisible()

  const restoredSrc = await page.locator('.photo-preview img').getAttribute('src')
  expect(restoredSrc, 'no photo restored after reload').toBeTruthy()

  const restored = await measure(page, restoredSrc)
  expect(restored.width, 'restored photo is not square — the ORIGINAL came back, not the crop').toBe(restored.height)
  expect(restored.width).toBe(beforeReload.width)

  await context.close()
})

// The bug Jaan found in live testing: image/svg+xml passed the old `image/*` check. Strapi then
// stores an SVG untouched and generates NO square variants for it, so the avatar looks fine on
// upload and every page asking for _med_sq gets a 404.
test('an SVG is refused, and the picker does not offer one', async ({ browser }) => {
  const { context, page } = await prepareCheckoutPage({
    browser,
    items: [cartItem({ componentId: 1005, productId: 7005, title: 'SVG pass', locationId: 505 })]
  })

  await page.goto(checkoutUrl())
  await expect(page.getByRole('heading', { name: 'Your profile' })).toBeVisible()

  const input = page.locator('.photo-upload input[type="file"]')
  // TIFF is offered because the server converts it; SVG is not offered and not accepted.
  await expect(input).toHaveAttribute('accept', 'image/jpeg,image/png,image/webp,image/tiff')

  await input.setInputFiles({
    name: 'logo.svg',
    mimeType: 'image/svg+xml',
    buffer: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="900" height="900"><rect width="900" height="900" fill="red"/></svg>')
  })

  await expect(page.locator('.photo-error')).toBeVisible()
  await expect(page.locator('.photo-error')).toContainText('WebP')
  await expect(page.getByRole('dialog')).toBeHidden()

  await context.close()
})
