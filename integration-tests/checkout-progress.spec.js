import { expect, test } from '@playwright/test'

const buyerProfile = {
  email: 'buyer@example.test',
  firstName: 'Test',
  lastName: 'Buyer',
  picture: 'https://assets.example.test/buyer.jpg'
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
    pickupLocations: [
      {
        id: locationId,
        name: `Pickup ${locationId}`,
        raw: { address: 'Tallinn' }
      }
    ]
  }
}

function checkoutContext (items) {
  return {
    user: { id: 1, email: buyerProfile.email },
    profile: buyerProfile,
    businessProfiles: [invoiceProfile],
    paymentMethods: {
      banklinks: [{ id: 'bank-test', name: 'Test bank', logo: '' }],
      cards: [],
      other: [],
      payLater: []
    },
    cart: {
      id: 10,
      items,
      total: items.reduce((sum, item) => sum + item.price, 0),
      secondsRemaining: 1800
    }
  }
}

async function prepareCheckoutPage ({ browser, initialItems }) {
  const context = await browser.newContext()
  await context.addCookies([
    { name: 'checkout_token', value: 'integration-token', domain: 'localhost', path: '/' }
  ])

  const page = await context.newPage()
  let items = initialItems

  await page.route('**/api/checkout/context?**', route => {
    route.fulfill({ json: checkoutContext(items) })
  })
  await page.route('**/api/cart/touch', route => {
    route.fulfill({ json: checkoutContext(items).cart })
  })
  await page.route('**/api/business-profiles/**', route => {
    route.fulfill({ json: invoiceProfile })
  })

  return {
    context,
    page,
    setItems (nextItems) { items = nextItems }
  }
}

async function openCheckout (page) {
  await page.goto(checkoutUrl())
  await expect(page.getByRole('heading', { name: 'Complete your order' })).toBeVisible()
}

function checkoutUrl (params = {}) {
  const url = new URL('/checkout', 'http://localhost:3000')
  url.searchParams.set('locale', 'en')
  url.searchParams.set('shop_url', 'http://localhost:4000/en/shop')
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value)
  return `${url.pathname}${url.search}`
}

async function completeItemDetails (page, locationName = 'Pickup 501') {
  await page.getByRole('button', { name: new RegExp(locationName) }).click()
  await expect(page.getByRole('button', { name: /Continue/ })).toBeEnabled()
  await page.getByRole('button', { name: /Continue/ }).click()
}

async function selectInvoiceProfileAndContinue (page) {
  await page.getByRole('button', { name: /Test Buyer/ }).click()
  await page.getByRole('button', { name: /Continue/ }).click()
  await expect(page.getByRole('heading', { name: 'Payment' })).toBeVisible()
  await page.waitForTimeout(600)
}

test('restores checkout progress after reload', async ({ browser }) => {
  const { context, page } = await prepareCheckoutPage({
    browser,
    initialItems: [cartItem({ componentId: 1001, productId: 7001, title: 'Reload pass', locationId: 501 })]
  })

  await openCheckout(page)
  await completeItemDetails(page)
  await selectInvoiceProfileAndContinue(page)

  await page.reload()

  await expect(page.getByRole('heading', { name: 'Payment' })).toBeVisible()
  await expect(page.getByText('Reload pass')).toBeVisible()
  await page.getByRole('button', { name: /Item details/ }).click()
  await expect(page.getByRole('button', { name: /Reload pass Pickup: Pickup 501/ })).toBeVisible()

  await context.close()
})

test('keeps matching checkout progress when another tab removes an item', async ({ browser }) => {
  const keptItem = cartItem({ componentId: 2002, productId: 8002, title: 'Kept pass', locationId: 602 })
  const removedItem = cartItem({ componentId: 2001, productId: 8001, title: 'Removed pass', locationId: 601 })
  const { context, page, setItems } = await prepareCheckoutPage({
    browser,
    initialItems: [removedItem, keptItem]
  })

  await openCheckout(page)
  await page.getByRole('button', { name: /Pickup 601/ }).click()
  await page.getByRole('button', { name: /Pickup 602/ }).click()
  await page.getByRole('button', { name: /Continue/ }).click()
  await selectInvoiceProfileAndContinue(page)

  setItems([keptItem])
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  await page.waitForTimeout(600)
  await page.reload()

  await expect(page.getByRole('heading', { name: 'Payment' })).toBeVisible()
  await expect(page.getByText('Kept pass')).toBeVisible()
  await expect(page.getByText('Removed pass')).toHaveCount(0)
  await page.getByRole('button', { name: /Item details/ }).click()
  await expect(page.getByRole('button', { name: /Kept pass Pickup: Pickup 602/ })).toBeVisible()

  await context.close()
})

test('restores checkout progress after payment cancellation return', async ({ browser }) => {
  const { context, page } = await prepareCheckoutPage({
    browser,
    initialItems: [cartItem({ componentId: 3001, productId: 9001, title: 'Cancelled payment pass', locationId: 701 })]
  })

  await openCheckout(page)
  await completeItemDetails(page, 'Pickup 701')
  await selectInvoiceProfileAndContinue(page)

  await page.goto(checkoutUrl({ result: 'cancelled' }))

  await expect(page.getByRole('heading', { name: 'Payment' })).toBeVisible()
  await expect(page.getByText('You can try again or choose a different payment method.')).toBeVisible()
  await expect(page.getByText('Cancelled payment pass')).toBeVisible()

  await context.close()
})

test('restores the gift notification checkbox after immediate reload', async ({ browser }) => {
  const { context, page } = await prepareCheckoutPage({
    browser,
    initialItems: [cartItem({
      componentId: 4001,
      productId: 9101,
      title: 'Gift pass',
      locationId: 801,
      transferable: true
    })]
  })

  await openCheckout(page)
  await page.getByRole('button', { name: /Pickup 801/ }).click()
  await page.getByRole('button', { name: 'As a gift' }).click()
  // Email is asked first now, and 'Email *' would also match 'Confirm email *' without exact.
  await page.getByLabel('Email *', { exact: true }).fill('gift@example.test')
  await page.getByLabel('Confirm email *').fill('gift@example.test')
  await page.getByLabel('First name *').fill('Gift')
  await page.getByLabel('Last name *').fill('Person')
  await page.getByLabel("Don't send notification email").check()

  await page.reload()

  await expect(page.getByRole('button', { name: /Gift pass/ })).toBeVisible()
  await expect(page.getByRole('button', { name: 'As a gift' })).toHaveClass(/active/)
  await expect(page.getByLabel("Don't send notification email")).toBeChecked()

  await context.close()
})

test('redirects anonymous checkout through guest cart claim before login', async ({ browser }) => {
  const context = await browser.newContext()
  const page = await context.newPage()

  await page.goto(checkoutUrl())

  await expect(page).toHaveURL(/\/\?redirect_uri=/)
  const redirected = new URL(page.url())
  expect(redirected.searchParams.get('locale')).toBe('en')

  const redirectUri = new URL(redirected.searchParams.get('redirect_uri'))
  expect(redirectUri.origin).toBe('http://localhost:4000')
  expect(redirectUri.pathname).toBe('/shop/cart/claim')

  const next = new URL(redirectUri.searchParams.get('next'))
  expect(next.origin).toBe('http://localhost:3000')
  expect(next.pathname).toBe('/checkout')
  expect(next.searchParams.get('locale')).toBe('en')
  expect(next.searchParams.get('shop_url')).toBe('http://localhost:4000/en/shop')
  expect(next.searchParams.has('jwt')).toBe(true)

  await context.close()
})
