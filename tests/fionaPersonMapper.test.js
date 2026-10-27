import { describe, it, expect } from 'vitest'
import { buildPersonPayload } from '../server/utils/fiona/personMapper.js'

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
    expect(payload).toEqual({ firstName: 'Mari', lastName: 'Maasikas', firstNameLastName: 'Mari Maasikas', bio_en: 'Bio' })
  })
})
