import { readFileSync } from 'node:fs'
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

// Mirrors the served defaults; used when a test needs to override one field without blanking the rest.
const DEFAULT_RULES_FOR_TEST = {
  minSourceWidth: 600,
  minSourceHeight: 600,
  maxOutputSize: 1600,
  minOutputSize: 600,
  maxFileBytes: 5 * 1024 * 1024,
  aspectRatio: 1,
  allowedMimeTypes: ['image/jpeg', 'image/png', 'image/webp'],
  convertibleMimeTypes: ['image/tiff']
}

async function prepareCheckoutPage ({ browser, items, profile = buyerProfileWithoutPicture, rules = null }) {
  const context = await browser.newContext()
  await context.addCookies([{ name: 'checkout_token', value: 'integration-token', domain: 'localhost', path: '/' }])

  const page = await context.newPage()
  const profileRequests = []

  await page.route('**/api/checkout/context?**', route => route.fulfill({ json: checkoutContext(items, profile) }))
  await page.route('**/api/cart/touch', route => route.fulfill({ json: checkoutContext(items, profile).cart }))
  await page.route('**/api/business-profiles/**', route => route.fulfill({ json: invoiceProfile }))

  // Always mocked, so the tests do not depend on whatever production config happens to be live.
  // faceChecks defaults OFF because the synthetic fixtures contain no face by construction, and
  // tier 2 would otherwise block every crop and quality test. The tier-2 tests opt in explicitly.
  await page.route('**/api/config/photo-rules', route => route.fulfill({
    json: rules || { ...DEFAULT_RULES_FOR_TEST, faceChecks: { enabled: false } }
  }))

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

// `detail: 'sharp'` by default: a smooth gradient legitimately reads as blurry to the tier 1
// check, and these tests are about cropping, not image quality.
async function choosePhoto (page, { width, height, name = 'portrait.png', detail = 'sharp' }) {
  await page.locator('.photo-upload input[type="file"]').setInputFiles({
    name,
    mimeType: 'image/png',
    buffer: makePng(width, height, { detail })
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
    rules: { minSourceWidth: 1000, minSourceHeight: 1000, maxOutputSize: 800, minOutputSize: 400, maxFileBytes: 5242880, aspectRatio: 1, faceChecks: { enabled: false } }
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
  await page.getByLabel('Email *', { exact: true }).fill('gift@example.test')

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

// Tier 1 quality checks, exercised on real pixels in a real canvas — the part the unit tests
// cannot reach, since measureImageQuality needs a browser.
test('a blurry photo is blocked and cannot be clicked past', async ({ browser }) => {
  const { context, page } = await prepareCheckoutPage({
    browser,
    items: [cartItem({ componentId: 1006, productId: 7006, title: 'Blur pass', locationId: 506 })]
  })

  await page.goto(checkoutUrl())
  await expect(page.getByRole('heading', { name: 'Your profile' })).toBeVisible()

  // A near-flat ramp: almost no local contrast, so Laplacian variance sits far below the block
  // threshold.
  await page.locator('.photo-upload input[type="file"]').setInputFiles({
    name: 'blurry.png',
    mimeType: 'image/png',
    buffer: makePng(900, 900, { detail: 'blur' })
  })

  await expect(page.getByRole('dialog')).toBeVisible()
  await page.getByRole('button', { name: 'Use this photo' }).click()

  await expect(page.locator('.photo-cropper-findings li.block')).toBeVisible()
  // The cropper stays open and the button is disabled — a block is not acknowledgeable.
  await expect(page.getByRole('dialog')).toBeVisible()
  await expect(page.locator('.photo-cropper-confirm')).toBeDisabled()

  await context.close()
})

test('a sharp photo passes the quality checks without complaint', async ({ browser }) => {
  const { context, page } = await prepareCheckoutPage({
    browser,
    items: [cartItem({ componentId: 1007, productId: 7007, title: 'Sharp pass', locationId: 507 })]
  })

  await page.goto(checkoutUrl())
  await expect(page.getByRole('heading', { name: 'Your profile' })).toBeVisible()

  await page.locator('.photo-upload input[type="file"]').setInputFiles({
    name: 'sharp.png',
    mimeType: 'image/png',
    buffer: makePng(900, 900, { detail: 'sharp' })
  })

  await expect(page.getByRole('dialog')).toBeVisible()
  await page.getByRole('button', { name: 'Use this photo' }).click()

  // No findings at all, so it is accepted on the first press.
  await expect(page.getByRole('dialog')).toBeHidden()
  await expect(page.locator('.photo-preview img')).toBeVisible()

  await context.close()
})

test('the kill switch turns the whole tier off', async ({ browser }) => {
  const { context, page } = await prepareCheckoutPage({
    browser,
    items: [cartItem({ componentId: 1008, productId: 7008, title: 'Kill switch pass', locationId: 508 })],
    rules: { ...DEFAULT_RULES_FOR_TEST, qualityChecks: { enabled: false }, faceChecks: { enabled: false } }
  })

  await page.goto(checkoutUrl())
  await expect(page.getByRole('heading', { name: 'Your profile' })).toBeVisible()

  // The same image that was blocked above.
  await page.locator('.photo-upload input[type="file"]').setInputFiles({
    name: 'blurry.png',
    mimeType: 'image/png',
    buffer: makePng(900, 900, { detail: 'blur' })
  })

  await expect(page.getByRole('dialog')).toBeVisible()
  await page.getByRole('button', { name: 'Use this photo' }).click()

  await expect(page.getByRole('dialog')).toBeHidden()
  await expect(page.locator('.photo-cropper-findings')).toHaveCount(0)

  await context.close()
})

// Tier 2 with the REAL model, in a real browser. Slower than the rest of the suite, but it is the
// only way to know the 1.5 MB actually loads and that detection runs on a canvas.
test('tier 2 blocks a photo with no face in it', async ({ browser }) => {
  const { context, page } = await prepareCheckoutPage({
    browser,
    items: [cartItem({ componentId: 1009, productId: 7009, title: 'No face pass', locationId: 509 })],
    // Opts in: tier 2 is off in the default test config, since the synthetic fixtures have no face.
    rules: { ...DEFAULT_RULES_FOR_TEST, faceChecks: { enabled: true, blocking: ['faceMissing', 'faceMultiple'] } }
  })

  await page.goto(checkoutUrl())
  await expect(page.getByRole('heading', { name: 'Your profile' })).toBeVisible()

  // A sharp checkerboard: passes tier 1 comfortably, contains no face whatsoever.
  await choosePhoto(page, { width: 900, height: 900, name: 'no-face.png', detail: 'sharp' })
  await expect(page.getByRole('dialog')).toBeVisible()
  await page.getByRole('button', { name: /Use this photo|Checking photo/ }).click()

  // Generous timeout: this is the download of the model plus a detection pass.
  await expect(page.locator('.photo-cropper-findings li.block')).toBeVisible({ timeout: 30000 })
  await expect(page.locator('.photo-cropper-findings li.block')).toContainText('face')
  await expect(page.getByRole('dialog')).toBeVisible()

  await context.close()
})

test('faceChecks.enabled:false skips the model download entirely', async ({ browser }) => {
  const { context, page } = await prepareCheckoutPage({
    browser,
    items: [cartItem({ componentId: 1010, productId: 7010, title: 'No model pass', locationId: 510 })],
    rules: { ...DEFAULT_RULES_FOR_TEST, faceChecks: { enabled: false } }
  })

  const modelRequests = []
  await page.route('**/face-models/**', (route) => {
    modelRequests.push(route.request().url())
    return route.continue()
  })

  await page.goto(checkoutUrl())
  await expect(page.getByRole('heading', { name: 'Your profile' })).toBeVisible()

  await choosePhoto(page, { width: 900, height: 900, name: 'no-face.png', detail: 'sharp' })
  await expect(page.getByRole('dialog')).toBeVisible()
  await page.getByRole('button', { name: 'Use this photo' }).click()

  // Accepted with no face check at all, and crucially nothing was downloaded.
  await expect(page.getByRole('dialog')).toBeHidden()
  expect(modelRequests).toEqual([])

  await context.close()
})

// POSITIVE CONTROL. The "no face" test above would also pass if detection were broken and always
// returned zero faces, so this proves the detector really does find faces in a photograph.
//
// It uses a group photo from the face-api package rather than a committed single-face fixture: a
// stock photograph of identifiable people is not something to add to this repo. The discrimination
// is what matters — a broken detector would report faceMissing here, not faceMultiple.
test('tier 2 detects real faces rather than always reporting none', async ({ browser }) => {
  const groupPhoto = readFileSync('node_modules/@vladmandic/face-api/demo/sample1.jpg')

  const { context, page } = await prepareCheckoutPage({
    browser,
    items: [cartItem({ componentId: 1011, productId: 7011, title: 'Group photo pass', locationId: 511 })],
    // Tier 1 off: sample1 is a dim stock photo that legitimately trips the exposure block, which
    // would short-circuit before the face check ran and mask the result entirely.
    rules: {
      ...DEFAULT_RULES_FOR_TEST,
      qualityChecks: { enabled: false },
      faceChecks: { enabled: true, blocking: ['faceMissing', 'faceMultiple'], faceMinHeightRatio: 0, faceMaxHeightRatio: 1, faceMaxCentreOffset: 1, faceMaxTiltDegrees: 90, eyeOpenMinRatio: 0 }
    }
  })

  await page.goto(checkoutUrl())
  await expect(page.getByRole('heading', { name: 'Your profile' })).toBeVisible()
  await page.locator('.photo-upload input[type="file"]').setInputFiles({ name: 'group.jpg', mimeType: 'image/jpeg', buffer: groupPhoto })
  await expect(page.getByRole('dialog')).toBeVisible()
  await page.locator('.photo-cropper-confirm').click()

  const block = page.locator('.photo-cropper-findings li.block')
  await expect(block).toBeVisible({ timeout: 30000 })
  // The specific message is the point: it found SEVERAL faces, so detection is working. A dead
  // detector would say it could not find a face at all.
  await expect(block).toContainText('more than one')
  await expect(block).not.toContainText('could not find')

  await context.close()
})

// And the other half of the proof: a detected face is let THROUGH when only faceMissing blocks.
test('a photo with faces detected is accepted when only faceMissing blocks', async ({ browser }) => {
  const groupPhoto = readFileSync('node_modules/@vladmandic/face-api/demo/sample1.jpg')

  const { context, page } = await prepareCheckoutPage({
    browser,
    items: [cartItem({ componentId: 1012, productId: 7012, title: 'Faces ok pass', locationId: 512 })],
    rules: {
      ...DEFAULT_RULES_FOR_TEST,
      qualityChecks: { enabled: false },
      faceChecks: { enabled: true, blocking: ['faceMissing'], faceMinHeightRatio: 0, faceMaxHeightRatio: 1, faceMaxCentreOffset: 1, faceMaxTiltDegrees: 90, eyeOpenMinRatio: 0 }
    }
  })

  await page.goto(checkoutUrl())
  await expect(page.getByRole('heading', { name: 'Your profile' })).toBeVisible()
  await page.locator('.photo-upload input[type="file"]').setInputFiles({ name: 'group.jpg', mimeType: 'image/jpeg', buffer: groupPhoto })
  await expect(page.getByRole('dialog')).toBeVisible()

  // First press shows the multiple-faces WARNING, second accepts it.
  await page.locator('.photo-cropper-confirm').click()
  await expect(page.locator('.photo-cropper-findings li.warn')).toBeVisible({ timeout: 30000 })
  await expect(page.locator('.photo-cropper-findings li.block')).toHaveCount(0)
  await page.locator('.photo-cropper-confirm').click()

  await expect(page.getByRole('dialog')).toBeHidden({ timeout: 15000 })
  await expect(page.locator('.photo-preview img')).toBeVisible()

  await context.close()
})

// Gifting to someone whose account already holds details: the buyer is asked only for what is
// missing, and never shown what is there.
test('a recipient with a photo on file is not asked for one', async ({ browser }) => {
  const { context, page } = await prepareCheckoutPage({
    browser,
    items: [cartItem({ componentId: 5001, productId: 9501, title: 'Gift pass', locationId: 901, transferable: true })],
    profile: { ...buyerProfileWithoutPicture, picture: 'https://assets.example.test/buyer.jpg' }
  })

  // The recipient already has everything.
  await page.route('**/api/checkout/owner/lookup', route => route.fulfill({
    json: { existing: true, onFile: ['firstName', 'lastName', 'picture'], missing: [] }
  }))

  await page.goto(checkoutUrl())
  await page.getByRole('button', { name: /Pickup 901/ }).click()
  await page.getByRole('button', { name: 'As a gift' }).click()

  // Email comes first now; the lookup fires on blur.
  await page.getByLabel('Email *', { exact: true }).fill('known@example.test')
  await page.getByLabel('Confirm email *').fill('known@example.test')

  await expect(page.getByText(/already have this on file/)).toBeVisible()
  // Asked for nothing else — and shown none of it.
  await expect(page.locator('.owner-form .photo-upload')).toHaveCount(0)
  await expect(page.getByLabel('First name *')).toHaveCount(0)
  await expect(page.getByRole('button', { name: /Continue/ })).toBeEnabled()

  await context.close()
})

test('a recipient missing only a photo is asked only for the photo', async ({ browser }) => {
  const { context, page } = await prepareCheckoutPage({
    browser,
    items: [cartItem({ componentId: 5002, productId: 9502, title: 'Gift pass', locationId: 902, transferable: true })],
    profile: { ...buyerProfileWithoutPicture, picture: 'https://assets.example.test/buyer.jpg' },
    rules: { ...DEFAULT_RULES_FOR_TEST, faceChecks: { enabled: false } }
  })

  await page.route('**/api/checkout/owner/lookup', route => route.fulfill({
    json: { existing: true, onFile: ['firstName', 'lastName'], missing: ['picture'] }
  }))

  await page.goto(checkoutUrl())
  await page.getByRole('button', { name: /Pickup 902/ }).click()
  await page.getByRole('button', { name: 'As a gift' }).click()
  await page.getByLabel('Email *', { exact: true }).fill('halfway@example.test')
  await page.getByLabel('Confirm email *').fill('halfway@example.test')

  await expect(page.getByLabel('First name *')).toHaveCount(0)
  await expect(page.locator('.owner-form .photo-upload')).toBeVisible()

  await context.close()
})

// The typo guard. Without it a mistyped address landing on a real account would pass silently.
test('mismatched email addresses block the item', async ({ browser }) => {
  const { context, page } = await prepareCheckoutPage({
    browser,
    items: [cartItem({ componentId: 5003, productId: 9503, title: 'Gift pass', locationId: 903, transferable: true })],
    profile: { ...buyerProfileWithoutPicture, picture: 'https://assets.example.test/buyer.jpg' }
  })

  await page.route('**/api/checkout/owner/lookup', route => route.fulfill({
    json: { existing: true, onFile: ['firstName', 'lastName', 'picture'], missing: [] }
  }))

  await page.goto(checkoutUrl())
  await page.getByRole('button', { name: /Pickup 903/ }).click()
  await page.getByRole('button', { name: 'As a gift' }).click()
  await page.getByLabel('Email *', { exact: true }).fill('right@example.test')
  await page.getByLabel('Confirm email *').fill('wrogn@example.test')

  await expect(page.getByText(/do not match/)).toBeVisible()
  await expect(page.getByRole('button', { name: /Continue/ })).toBeDisabled()

  await context.close()
})
