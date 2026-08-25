import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { describe, expect, test } from 'vitest'

const __dirname = dirname(fileURLToPath(import.meta.url))
const read = rel => readFileSync(resolve(__dirname, rel), 'utf8')

const strapiSource = read('../server/utils/strapi.js')
const indexSource = read('../pages/checkout/index.vue')
const invoiceStepSource = read('../pages/checkout/components/CheckoutInvoiceStep.vue')
const copyDefaults = JSON.parse(read('../utils/checkoutCopyDefaults.json'))

// A customer's saved company profile appeared to vanish mid-checkout and returned on its own.
// The list was never empty — it could not be read, and an unreadable list rendered exactly like
// an empty one.
describe('unreadable invoice profiles are not shown as absent', () => {
  test('an unreadable list returns null, not an empty array', () => {
    const fn = strapiSource.slice(strapiSource.indexOf('async function getOwnBusinessProfiles'))
    expect(fn).toMatch(/return null/)
    expect(fn).toMatch(/Array\.isArray\(profiles\)/)
    // A 200 carrying an error body must not pass as "no profiles".
    expect(fn).toMatch(/expected an array/)
  })

  test('the read is retried once before giving up', () => {
    const fn = strapiSource.slice(strapiSource.indexOf('async function getOwnBusinessProfiles'))
    expect(fn).toMatch(/attempt < 2/)
  })

  test('the context carries the distinction as a flag, keeping the list an array', () => {
    expect(strapiSource).toMatch(/businessProfilesUnavailable: businessProfiles === null/)
    expect(strapiSource).toMatch(/businessProfiles: Array\.isArray\(businessProfiles\) \? businessProfiles : \[\]/)
  })

  test('a failed refresh keeps the list on screen instead of blanking it', () => {
    const fn = indexSource.slice(indexSource.indexOf('async function refreshBusinessProfiles'))
    expect(fn).toMatch(/businessProfilesUnavailable: true/)
    // The old version replaced a non-array with [], which is the bug in miniature.
    expect(fn).not.toMatch(/Array\.isArray\(profiles\) \? profiles : \[\]/)
  })

  test('the buyer is told, in every locale, that the list failed to load', () => {
    expect(invoiceStepSource).toContain('savedProfilesUnavailable')
    expect(invoiceStepSource).toContain('retry-profiles')
    for (const locale of ['en', 'et', 'ru']) {
      expect(copyDefaults[locale].savedProfilesUnavailable).toBeTruthy()
    }
  })
})

describe('gift email confirmation appears when it can mean something', () => {
  const itemStep = read('../pages/checkout/components/CheckoutItemStep.vue')

  test('the confirm field waits for a plausible address', () => {
    expect(itemStep).toMatch(/v-if="giftEmailLooksValid\(item, index\)"/)
  })

  test('the reveal and the lookup share one pattern, so they cannot disagree', () => {
    expect(itemStep).toContain('const EMAIL_PATTERN =')
    expect(itemStep.match(/EMAIL_PATTERN\.test/g)?.length).toBeGreaterThanOrEqual(2)
  })
})
