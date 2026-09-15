/**
 * authenticateStrapiUser — finding or creating the Strapi account behind an email.
 * $fetch is globally mocked in setup.js; each test configures only the responses it needs.
 *
 * The silent path exists for surprise gifts: /auth/local/register always mails the
 * confirm-register template, so an account created for a gift the buyer asked us not to announce
 * goes through POST /users instead.
 */
import { describe, it, expect, vi } from 'vitest'
import jwt from 'jsonwebtoken'
import { authenticateStrapiUser } from '../server/utils/strapi.js'

const SERVICE_TOKEN = jwt.sign({ id: 16998 }, 'test-secret', { expiresIn: '1h' })

function mockStrapi ({ existing = [] } = {}) {
  globalThis.$fetch = vi.fn().mockImplementation((url, opts = {}) => {
    if (url.endsWith('/auth/local')) return { jwt: SERVICE_TOKEN }
    if (url.includes('/users?email=')) return existing
    if (url.endsWith('/auth/local/register')) {
      return { user: { id: 501, email: opts.body.email, confirmed: false } }
    }
    if (url.endsWith('/users') && opts.method === 'POST') {
      return { id: 502, email: opts.body.email, confirmed: opts.body.confirmed }
    }
    throw new Error(`unexpected ${opts.method || 'GET'} ${url}`)
  })
}

const callsTo = (suffix, method) => globalThis.$fetch.mock.calls
  .filter(([url, opts = {}]) => url.endsWith(suffix) && (!method || opts.method === method))

describe('authenticateStrapiUser', () => {
  it('returns null without calling Strapi when there is no email', async () => {
    mockStrapi()
    expect(await authenticateStrapiUser('')).toBeNull()
    expect(globalThis.$fetch).not.toHaveBeenCalled()
  })

  it('returns an existing account and creates nothing', async () => {
    mockStrapi({ existing: [{ id: 42, email: 'olemas@poff.ee', confirmed: true, profileFilled: true }] })

    const user = await authenticateStrapiUser('olemas@poff.ee', { sendAccountEmail: false })

    expect(user).toMatchObject({ id: '42', email: 'olemas@poff.ee', confirmed: true, profile: true })
    expect(callsTo('/auth/local/register')).toHaveLength(0)
    expect(callsTo('/users', 'POST')).toHaveLength(0)
  })

  it('encodes the email in the lookup so a + address is found', async () => {
    mockStrapi({ existing: [{ id: 43, email: 'jaan+kink@poff.ee' }] })

    await authenticateStrapiUser('jaan+kink@poff.ee')

    const [[lookupUrl]] = globalThis.$fetch.mock.calls.filter(([url]) => url.includes('/users?email='))
    expect(lookupUrl).toContain('/users?email=jaan%2Bkink%40poff.ee')
  })

  it('registers a missing account by default (Strapi sends the account mail)', async () => {
    mockStrapi()

    const user = await authenticateStrapiUser('uus@poff.ee')

    expect(user).toMatchObject({ id: '501', email: 'uus@poff.ee' })
    expect(callsTo('/auth/local/register')).toHaveLength(1)
    expect(callsTo('/users', 'POST')).toHaveLength(0)
  })

  it('registers a missing account when sendAccountEmail is true', async () => {
    mockStrapi()

    await authenticateStrapiUser('uus@poff.ee', { sendAccountEmail: true })

    expect(callsTo('/auth/local/register')).toHaveLength(1)
    expect(callsTo('/users', 'POST')).toHaveLength(0)
  })

  it('creates a missing account silently when sendAccountEmail is false', async () => {
    mockStrapi()

    const user = await authenticateStrapiUser('ullatus@poff.ee', { sendAccountEmail: false })

    expect(user).toMatchObject({ id: '502', email: 'ullatus@poff.ee', confirmed: true })
    expect(callsTo('/auth/local/register')).toHaveLength(0)

    const creates = callsTo('/users', 'POST')
    expect(creates).toHaveLength(1)
    const [, opts] = creates[0]
    expect(opts.headers).toEqual({ Authorization: `Bearer ${SERVICE_TOKEN}` })
    expect(opts.body).toMatchObject({
      email: 'ullatus@poff.ee',
      username: 'ullatus@poff.ee',
      confirmed: true,
      provider: 'local',
      externalProviders: [{ provider: 'local', UUID: 'not set yet' }]
    })
    expect(opts.body.password).toMatch(/^[0-9a-f]{64}$/)
    expect(Date.parse(opts.body.externalProviders[0].dateConnected)).not.toBeNaN()
  })
})
