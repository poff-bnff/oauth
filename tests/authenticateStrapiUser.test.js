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
import { authenticateStrapiUser, getStrapiUser } from '../server/utils/strapi.js'

const SERVICE_TOKEN = jwt.sign({ id: 16998 }, 'test-secret', { expiresIn: '1h' })
// getStrapiUser (used to resolve an alias to its main account) logs in as admin and caches that
// token by its exp claim, so it needs a decodable JWT with an exp in the future.
const ADMIN_JWT = jwt.sign({ id: 1 }, 'test-secret', { expiresIn: '1h' })

// `byId` answers GET /users/:id (what getStrapiUser fetches); `onUserById` runs before each such answer.
function mockStrapi ({ existing = [], byId = {}, onUserById = () => {} } = {}) {
  globalThis.$fetch = vi.fn().mockImplementation((url, opts = {}) => {
    if (url.endsWith('/auth/local')) return { jwt: SERVICE_TOKEN }
    if (url.includes('/admin/login')) return { data: { token: ADMIN_JWT } }
    if (url.includes('/users?email=')) return existing
    const byIdMatch = url.match(/\/users\/(\d+)$/)
    if (byIdMatch) {
      onUserById(Number(byIdMatch[1]))
      if (byId[byIdMatch[1]]) return byId[byIdMatch[1]]
    }
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
const userByIdCalls = () => globalThis.$fetch.mock.calls.filter(([url]) => /\/users\/\d+$/.test(url))

// Main accounts carry aliasUsers: [] because mergeUserMy reads that array unguarded; a non-empty
// list would make it fetch the aliases, which is not what these tests are about.
const MAIN_USER = {
  id: 42,
  email: '47807310298@example.ee',
  confirmed: true,
  profileFilled: true,
  user_profile: { firstName: 'Katri', lastName: 'Riet' },
  aliasUsers: []
}

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

// A Strapi user can be an alias of a main account (mainUser set). Only the main account owns the
// profile, the products and the transactions, so the shop session must be the main account even
// when the person logged in with the alias address.
describe('authenticateStrapiUser with alias accounts', () => {
  it('resolves an alias login to its main account', async () => {
    mockStrapi({
      existing: [{ id: 41, email: 'katriliis@example.ee', confirmed: true, mainUser: { id: 42 } }],
      byId: { 42: MAIN_USER }
    })

    const user = await authenticateStrapiUser('katriliis@example.ee')

    expect(user).toMatchObject({ id: '42', email: '47807310298@example.ee', firstName: 'Katri', profile: true })
    expect(callsTo('/auth/local/register')).toHaveLength(0)
    expect(callsTo('/users', 'POST')).toHaveLength(0)
  })

  it('does not fetch the user record again when the login email is a main account', async () => {
    mockStrapi({ existing: [{ id: 42, email: '47807310298@example.ee', confirmed: true }] })

    const user = await authenticateStrapiUser('47807310298@example.ee')

    expect(user).toMatchObject({ id: '42' })
    expect(userByIdCalls()).toHaveLength(0)
  })
})

describe('getStrapiUser with a self-referencing mainUser', () => {
  it('treats a user whose mainUser is itself as the main account instead of recursing', async () => {
    let fetches = 0
    mockStrapi({
      byId: { 42: { ...MAIN_USER, mainUser: { id: 42 } } },
      onUserById: () => { if (++fetches > 3) throw new Error('GET /users/42 requested more than 3 times: recursion') }
    })

    const user = await getStrapiUser(42)

    expect(user).toMatchObject({ id: 42, email: '47807310298@example.ee' })
    expect(fetches).toBe(1)
  })
})
