import { describe, expect, test } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const checkoutItemStepSource = readFileSync(
  resolve(__dirname, '../pages/checkout/components/CheckoutItemStep.vue'),
  'utf8'
)

describe('checkout item step source', () => {
  test('uses shared checkout progress item keys', () => {
    expect(checkoutItemStepSource).toContain("from '../composables/useCheckoutProgress.js'")
    expect(checkoutItemStepSource).toContain('itemKey')
    expect(checkoutItemStepSource).not.toMatch(/function\s+itemKey\s*\(/)
  })
})
