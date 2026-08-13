/**
 * Regression: Maksekeskus validates `amount` against `###.##` and rejects anything
 * else with code 1001. Summing item prices as raw floats produced values like
 * 0.30000000000000004, which made checkout impossible for affected carts —
 * observed live on 2026-08-13 with three 0.10 passes.
 */
import { describe, expect, it } from 'vitest'
import { sumCheckoutPrices } from '../server/utils/strapi.js'

const twoDecimalsOrFewer = value => Number.isInteger(Math.round(value * 100)) && value === Math.round(value * 100) / 100

describe('sumCheckoutPrices', () => {
  it('rounds the sum that broke live checkout (3 x 0.10)', () => {
    // Guard the premise: the naive sum really is unrepresentable.
    expect([0.1, 0.1, 0.1].reduce((sum, price) => sum + price, 0)).not.toBe(0.3)
    expect(sumCheckoutPrices([{ price: 0.1 }, { price: 0.1 }, { price: 0.1 }])).toBe(0.3)
  })

  it('rounds a realistic mixed-cents cart', () => {
    expect(sumCheckoutPrices([{ price: 5.1 }, { price: 25.2 }])).toBe(30.3)
  })

  it('leaves whole-euro and single-item totals untouched', () => {
    expect(sumCheckoutPrices([{ price: 35 }, { price: 15 }, { price: 45 }])).toBe(95)
    expect(sumCheckoutPrices([{ price: 0.1 }])).toBe(0.1)
    expect(sumCheckoutPrices([{ price: 0.1 }, { price: 0.1 }])).toBe(0.2)
  })

  it('treats missing, null, and non-numeric prices as zero', () => {
    expect(sumCheckoutPrices([{ price: 10 }, {}, { price: null }, { price: 'x' }])).toBe(10)
    expect(sumCheckoutPrices([])).toBe(0)
    expect(sumCheckoutPrices()).toBe(0)
  })

  it('always yields a value Maksekeskus can parse as ###.##', () => {
    const carts = [
      [{ price: 0.1 }, { price: 0.1 }, { price: 0.1 }],
      [{ price: 0.07 }, { price: 0.07 }, { price: 0.07 }],
      [{ price: 1.15 }, { price: 2.35 }, { price: 8.05 }],
      [{ price: 99.99 }, { price: 0.01 }]
    ]
    for (const cart of carts) expect(twoDecimalsOrFewer(sumCheckoutPrices(cart))).toBe(true)
  })
})
