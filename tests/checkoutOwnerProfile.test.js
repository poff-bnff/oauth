import { describe, expect, test } from 'vitest'
import { ownerProfileFieldsToFill } from '../server/utils/strapi.js'

// Gifting to someone who already has an account used to fail outright: the checkout collected the
// recipient's name and photo, then discarded them and refused the sale. It now completes an empty
// profile from what the buyer supplied — but only the empty parts.
describe('completing an existing gift recipient\'s profile', () => {
  const submitted = { firstName: 'Given', lastName: 'Supplied', email: 'buyer-typed@example.test' }

  test('fills a completely empty profile', () => {
    expect(ownerProfileFieldsToFill({}, submitted)).toEqual(submitted)
  })

  // The privacy rule. A buyer must not be able to rename someone else's account from checkout.
  test('NEVER overwrites a value the recipient already has', () => {
    const existing = { firstName: 'Their', lastName: 'Own', email: 'theirs@example.test' }
    expect(ownerProfileFieldsToFill(existing, submitted)).toEqual({})
  })

  test('fills only the blanks, leaving the rest untouched', () => {
    expect(ownerProfileFieldsToFill({ firstName: 'Their' }, submitted))
      .toEqual({ lastName: 'Supplied', email: 'buyer-typed@example.test' })
  })

  test('treats empty and whitespace-only values as blank, since Strapi stores both', () => {
    const filled = ownerProfileFieldsToFill({ firstName: '', lastName: '   ' }, submitted)
    expect(filled.firstName).toBe('Given')
    expect(filled.lastName).toBe('Supplied')
  })

  test('does not fill from a whitespace-only submission either', () => {
    expect(ownerProfileFieldsToFill({}, { firstName: '   ' })).toEqual({})
  })

  test('does not invent values the buyer did not supply', () => {
    expect(ownerProfileFieldsToFill({}, { firstName: 'Given' })).toEqual({ firstName: 'Given' })
  })

  test('copes with missing arguments rather than throwing', () => {
    expect(ownerProfileFieldsToFill()).toEqual({})
    expect(ownerProfileFieldsToFill(null, null)).toEqual({})
  })

  // The photo is handled separately because it must be uploaded before it can be referenced.
  test('never returns a picture field — that path uploads first', () => {
    expect(ownerProfileFieldsToFill({}, { ...submitted, picture: 99 }).picture).toBeUndefined()
  })
})
