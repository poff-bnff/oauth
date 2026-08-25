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

// The bug that reached production on 2026-08-19. The checkout began asking only for what a
// recipient was missing, so a buyer gifting to someone who already had a name legitimately sent
// none — and the server still demanded firstName/lastName up front, rejecting them with
// 'invalidOwner' before it had even looked at who the recipient was.
//
// resolveCheckoutOwner talks to Strapi, so the rule is asserted here as the decision table it
// implements. The point is that a required field must depend on what the recipient is MISSING.
describe('which fields the server may demand of a gift buyer', () => {
  const required = (missing, given) => {
    if (missing.includes('firstName') && !given.firstName) return 'invalidOwner'
    if (missing.includes('lastName') && !given.lastName) return 'invalidOwner'
    if (missing.includes('picture') && !given.photo) return 'ownerPhotoRequired'
    return null
  }

  test('a recipient with a name on file needs none from the buyer', () => {
    expect(required(['picture'], { firstName: '', lastName: '', photo: true })).toBeNull()
  })

  test('a recipient with everything on file needs nothing at all', () => {
    expect(required([], { firstName: '', lastName: '', photo: null })).toBeNull()
  })

  test('a recipient missing a name still needs one', () => {
    expect(required(['firstName', 'lastName'], { firstName: '', lastName: '', photo: true })).toBe('invalidOwner')
  })

  test('a recipient missing a photo still needs one', () => {
    expect(required(['picture'], { firstName: 'A', lastName: 'B', photo: null })).toBe('ownerPhotoRequired')
  })

  test('a brand-new recipient needs all of it', () => {
    const missing = ['firstName', 'lastName', 'picture']
    expect(required(missing, { firstName: '', lastName: '', photo: null })).toBe('invalidOwner')
    expect(required(missing, { firstName: 'A', lastName: 'B', photo: true })).toBeNull()
  })
})
