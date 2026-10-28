import { describe, it, expect } from 'vitest'
import { buildPersonPayload, valuesToClear } from '../server/utils/fiona/personMapper.js'

const fionaPerson = { firstName: 'Mari', lastName: 'Maasikas', email: 'mari@fiona.test', phone: '+372 555', bio: 'Bio' }
const build = (flags = {}, level = 1) => buildPersonPayload({ fionaPerson, level, contactEmail: 'mari@fiona.test', ...flags })

describe('buildPersonPayload privacy flags', () => {
  it('writes email and phone when nothing is withheld', () => {
    expect(build()).toMatchObject({ eMail: 'mari@fiona.test', phoneNr: '+372 555' })
  })

  it('"Do not publish contact details" withholds both', () => {
    const payload = build({ noPublicationOfContactDetails: true })
    expect(payload).not.toHaveProperty('eMail')
    expect(payload).not.toHaveProperty('phoneNr')
  })

  it('"Do not publish email info" withholds only the email', () => {
    const payload = build({ noPublicationOfEmail: true })
    expect(payload).not.toHaveProperty('eMail')
    expect(payload.phoneNr).toBe('+372 555')
  })

  it('"Do not publish phone info" withholds only the phone', () => {
    const payload = build({ noPublicationOfPhone: true })
    expect(payload.eMail).toBe('mari@fiona.test')
    expect(payload).not.toHaveProperty('phoneNr')
  })

  it('keeps names and the level 2 biography whatever is withheld', () => {
    const payload = build({ noPublicationOfContactDetails: true, noPublicationOfEmail: true, noPublicationOfPhone: true }, 2)
    expect(payload).toEqual({ firstName: 'Mari', lastName: 'Maasikas', firstNameLastName: 'Mari Maasikas', public: true, bio_en: 'Bio' })
  })
})

describe('buildPersonPayload public flag', () => {
  it('marks the person public, at both levels and whatever contact details are withheld', () => {
    expect(build({}, 1).public).toBe(true)
    expect(build({}, 2).public).toBe(true)
    expect(build({ noPublicationOfContactDetails: true }).public).toBe(true)
  })
})

describe('valuesToClear', () => {
  const fiona = { email: 'mari@fiona.test', phone: '+372 555 1234' }
  const clear = (existing, flags) => valuesToClear({ existing, fionaPerson: fiona, contactEmail: 'mari@fiona.test', ...flags })

  it('clears a stored email that equals the Fiona email when the email is withheld', () => {
    expect(clear({ eMail: 'Mari@Fiona.test ' }, { withholdEmail: true })).toEqual({ eMail: null })
  })

  it('clears a stored phone that equals the Fiona phone when the phone is withheld, ignoring spaces and signs', () => {
    expect(clear({ phoneNr: '3725551234' }, { withholdPhone: true })).toEqual({ phoneNr: null })
  })

  it('clears nothing when nothing is withheld', () => {
    expect(clear({ eMail: 'mari@fiona.test', phoneNr: '+372 555 1234' }, {})).toEqual({})
  })

  it('keeps values that differ from Fiona, or that are empty, or when there is no existing person', () => {
    expect(clear({ eMail: 'other@x.ee', phoneNr: '+372 999' }, { withholdEmail: true, withholdPhone: true })).toEqual({})
    expect(clear({ eMail: null, phoneNr: '' }, { withholdEmail: true, withholdPhone: true })).toEqual({})
    expect(clear(null, { withholdEmail: true, withholdPhone: true })).toEqual({})
  })

  it('keeps everything when Fiona holds no value to compare with', () => {
    expect(valuesToClear({ existing: { eMail: 'a@b.ee', phoneNr: '123' }, fionaPerson: {}, contactEmail: null, withholdEmail: true, withholdPhone: true })).toEqual({})
  })
})
