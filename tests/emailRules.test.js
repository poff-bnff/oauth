import { describe, expect, test } from 'vitest'
import { isUndeliverableEmail } from '../utils/emailRules.js'

describe('isUndeliverableEmail', () => {
  test.each([[''], [null], [undefined], ['   ']])('empty value %j is undeliverable', (value) => {
    expect(isUndeliverableEmail(value)).toBe(true)
  })

  test.each([
    ['38001010001@eesti.ee'],
    ['X@EESTI.EE'],
    ['a@eesti.ee '],
    ['  Mari@Eesti.ee']
  ])('%j is an eesti.ee address', (value) => {
    expect(isUndeliverableEmail(value)).toBe(true)
  })

  test.each([
    ['jaan@example.ee'],
    ['jaan@gmail.com'],
    ['jaan@mail.eesti.ee.example.com'],
    ['eesti.ee@example.com']
  ])('%j is deliverable', (value) => {
    expect(isUndeliverableEmail(value)).toBe(false)
  })
})
