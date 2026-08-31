import { describe, expect, test } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const strapiSource = readFileSync(resolve(__dirname, '../server/utils/strapi.js'), 'utf8')

// Adding to the basket locks the price the buyer is entitled to pay. A category price can change
// while they are still in checkout, and logging in is not a repricing event: a guest whose cart is
// merged must keep what they added at. Both merge paths used the opposite precedence.
describe('the basket price is a lock, not a snapshot to be refreshed', () => {
  test('no price site prefers the current price over the recorded one', () => {
    expect(strapiSource).not.toMatch(/getCheckoutProductCurrentPrice\(category\)\s*\?\?\s*item\.priceInCart/)
    expect(strapiSource).not.toMatch(/\(category && getCheckoutProductCurrentPrice\(category\)\)\s*\?\?\s*item\.priceInCart/)
  })

  test('the guest-merge paths fall back to the current price, never lead with it', () => {
    const matches = strapiSource.match(/item\.priceInCart \?\? [^\n]*getCheckoutProductCurrentPrice/g) || []
    expect(matches.length).toBe(2)
  })

  test('serializing the cart still prefers the recorded price', () => {
    expect(strapiSource).toMatch(/row\.priceInCart \|\| getCheckoutProductCurrentPrice\(category\)/)
  })
})

// hall and town are relations; with one level of population they arrive as bare ids. Rendering
// them put raw numbers into the pickup names a buyer chooses between ("Fotografiska, 22").
describe('pickup location names contain no relation ids', () => {
  test('non-string values are dropped rather than rendered', () => {
    expect(strapiSource).toMatch(/if \(typeof value !== 'string'\) return ''/)
  })

  test('the non-existent city field is no longer read', () => {
    expect(strapiSource).not.toMatch(/checkoutLocalizedText\(location\.city, locale\)/)
    expect(strapiSource).toMatch(/checkoutLocalizedText\(location\.town, locale\)/)
  })
})

// Paying moves the cart to checkout_started; the Maksekeskus callback converts it moments later.
// In that window the buyer is usually back on the site, and the stranded-cart recovery treated
// their completed purchase as an abandoned basket and restored it.
describe('a just-paid cart is not resurrected as a stranded one', () => {
  test('recovery checks whether the products have been sold', () => {
    expect(strapiSource).toMatch(/if \(await checkoutCartAlreadySold\(stranded\)\) return null/)
  })

  test('an unreadable check refuses to reactivate rather than guessing', () => {
    const fn = strapiSource.slice(strapiSource.indexOf('async function checkoutCartAlreadySold'))
    expect(fn).toMatch(/if \(!Array\.isArray\(products\)\) return true/)
    expect(fn.slice(0, fn.indexOf('export async function'))).toMatch(/catch[\s\S]*?return true/)
  })

  test('a sold product is one with an owner or a transaction', () => {
    expect(strapiSource).toMatch(/product\?\.owner \|\| \(Array\.isArray\(product\?\.transactions\)/)
  })
})

// Every cart and order in production was stamped "Kinoff": the lookup used url_contains, and
// "poff.ee" is a substring of kinoff.poff.ee, industry.poff.ee, shorts.poff.ee and four more.
// With _limit=1 and no sort, whichever row Postgres returned first won.
describe('the shop domain is resolved exactly, never by substring', () => {
  test('no substring matching is used for the domain', () => {
    // Match the query form, not the word — the comment above the function names the old
    // parameter to explain what went wrong, and should not fail its own test.
    expect(strapiSource).not.toMatch(/append\([^)]*url_contains/)
    expect(strapiSource).not.toMatch(/append\([^)]*name_contains/)
  })

  test('url is matched exactly, with name as a fallback', () => {
    const fn = strapiSource.slice(strapiSource.indexOf('async function resolveCheckoutDomainId'))
    expect(fn).toMatch(/lookup\('url', host\)/)
    expect(fn).toMatch(/lookup\('name', domainName\)/)
  })

  test('an unmatched host yields null rather than a guess', () => {
    const fn = strapiSource.slice(strapiSource.indexOf('async function resolveCheckoutDomainId'))
    expect(fn).toMatch(/\|\| null/)
  })
})
