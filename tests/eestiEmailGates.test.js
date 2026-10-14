import { describe, expect, it, vi, beforeEach } from 'vitest'
import {
  hasCheckoutBuyerProfile,
  missingCheckoutBuyerProfileFields,
  hasCompleteCheckoutBuyerProfile,
  missingBuyerProfileFields,
  validateCheckoutOwner
} from '../server/utils/strapi.js'

const FULL = {
  email: 'jaan@example.ee',
  firstName: 'Jaan',
  lastName: 'Tamm',
  birthdate: '1990-01-01',
  phoneNr: '+3725551234',
  gender: 'male',
  picture: 'pic.jpg'
}
const EESTI = { ...FULL, email: '38001010001@eesti.ee' }

describe('buyer profile gates treat an eesti.ee email as missing', () => {
  it('accepts a real address', () => {
    expect(hasCheckoutBuyerProfile(FULL)).toBe(true)
    expect(hasCompleteCheckoutBuyerProfile(FULL)).toBe(true)
    expect(missingCheckoutBuyerProfileFields(FULL)).toEqual([])
    expect(missingBuyerProfileFields(FULL)).toEqual([])
  })

  it('hasCheckoutBuyerProfile refuses eesti.ee', () => {
    expect(hasCheckoutBuyerProfile(EESTI)).toBe(false)
    expect(hasCheckoutBuyerProfile({ ...EESTI, email: 'A@EESTI.EE ' })).toBe(false)
  })

  it('missingCheckoutBuyerProfileFields lists email', () => {
    expect(missingCheckoutBuyerProfileFields(EESTI)).toEqual(['email'])
  })

  it('hasCompleteCheckoutBuyerProfile refuses eesti.ee', () => {
    expect(hasCompleteCheckoutBuyerProfile(EESTI)).toBe(false)
  })

  it('missingBuyerProfileFields lists email', () => {
    expect(missingBuyerProfileFields(EESTI)).toEqual(['email'])
  })
})

const b64 = value => Buffer.from(JSON.stringify(value)).toString('base64url')
const ADMIN_JWT = `${b64({ alg: 'none', typ: 'JWT' })}.${b64({ exp: Math.floor(Date.now() / 1000) + 3600 })}.sig`

describe('gift owner validation', () => {
  beforeEach(() => { globalThis.$fetch.mockReset() })

  it('refuses an eesti.ee recipient with ownerEmailUndeliverable', async () => {
    globalThis.$fetch.mockImplementation(async (url) => {
      if (String(url).includes('/admin/login')) return { data: { token: ADMIN_JWT } }
      if (String(url).includes('/product-categories/')) return { id: 1, transferable: true }
      return {}
    })
    const result = await validateCheckoutOwner(1, 1, {
      mode: 'gift', email: '38001010001@EESTI.ee', firstName: 'A', lastName: 'B', hasPhoto: true
    })
    expect(result).toEqual({ error: 'ownerEmailUndeliverable' })
  })
})
