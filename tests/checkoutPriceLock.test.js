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
