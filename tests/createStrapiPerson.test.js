/**
 * createStrapiPerson — the empty Creative Gate person that /api/addpro creates before it writes the form.
 * $fetch is globally mocked in setup.js.
 *
 * The placeholder is built from the user's user_profile, and a profile hunt created itself holds only
 * the email, so the name parts may be missing. They must not end up as the text "undefined undefined".
 */
import { describe, it, expect, vi } from 'vitest'
import jwt from 'jsonwebtoken'
import { createStrapiPerson } from '../server/utils/strapi.js'

const SERVICE_TOKEN = jwt.sign({ id: 16998 }, 'test-secret', { expiresIn: '1h' })

function mockStrapi () {
  globalThis.$fetch = vi.fn().mockImplementation((url, opts = {}) => {
    if (url.endsWith('/auth/local')) return { jwt: SERVICE_TOKEN }
    if (url.endsWith('/people') && opts.method === 'POST') return { id: 901, ...opts.body }
    if (/\/users\/\d+$/.test(url) && opts.method === 'PUT') return { id: 42 }
    throw new Error(`unexpected ${opts.method || 'GET'} ${url}`)
  })
}

const postedPerson = () => globalThis.$fetch.mock.calls
  .find(([url, opts = {}]) => url.endsWith('/people') && opts.method === 'POST')[1].body

describe('createStrapiPerson', () => {
  it('leaves firstNameLastName empty when the user profile has no names', async () => {
    mockStrapi()
    await createStrapiPerson({ id: 42, user_profile: { email: 'mari@example.com' } })
    expect(postedPerson().firstNameLastName).toBeNull()
  })

  it('joins the names the user profile has', async () => {
    mockStrapi()
    await createStrapiPerson({ id: 42, user_profile: { firstName: 'Mari', lastName: 'Maasikas' } })
    expect(postedPerson().firstNameLastName).toBe('Mari Maasikas')

    mockStrapi()
    await createStrapiPerson({ id: 42, user_profile: { firstName: 'Mari' } })
    expect(postedPerson().firstNameLastName).toBe('Mari')
  })
})
