import { describe, expect, test, vi, beforeEach, afterEach } from 'vitest'

// The profile email may only be set by the proven flow (/api/email -> oauth.ee e-mail login).
// These handlers are Nitro files that use auto-imported globals, so they are loaded with those
// globals stubbed.

// The handlers import through the Nuxt `~` alias, which vitest does not resolve here.
const strapiMock = vi.hoisted(() => ({ setStrapiUserProfile: vi.fn() }))
vi.mock('~/server/utils/strapi', () => strapiMock)
vi.mock('~/server/utils/userPicture', async () => await import('../server/utils/userPicture.js'))

const handlerGlobals = ['defineEventHandler', 'getUserIdFromEvent', 'readBody', 'readMultipartFormData',
  'getStrapiUser', 'setStrapiUserProfile', 'uploadStrapiImage', 'createStrapiUserProfile',
  'getCookie', 'setCookie', 'sendRedirect', 'getQuery', 'useRuntimeConfig', '$fetch',
  'getUserIdFromToken', 'emailInUse', 'authenticateStrapiUser', 'createError']

afterEach(() => {
  for (const name of handlerGlobals) delete globalThis[name]
  vi.resetModules()
})

describe('POST /api/checkout/profile', () => {
  let setProfile

  beforeEach(() => {
    setProfile = vi.fn().mockResolvedValue({})
    globalThis.defineEventHandler = fn => fn
    globalThis.getUserIdFromEvent = () => 7
    globalThis.getStrapiUser = vi.fn().mockResolvedValue({ id: 7, user_profile: { id: 70, email: 'jaan@example.ee' } })
    globalThis.setStrapiUserProfile = setProfile
    globalThis.uploadStrapiImage = vi.fn().mockResolvedValue({ id: 5 })
  })

  test('does not forward an email sent by the client, and needs none', async () => {
    globalThis.readBody = async () => ({ firstName: ' Jaan ', lastName: 'Tamm', email: 'x@eesti.ee' })
    const handler = (await import('../server/api/checkout/profile.post.js')).default

    const result = await handler({})

    expect(setProfile).toHaveBeenCalledTimes(1)
    expect(setProfile.mock.calls[0][1]).toEqual({ firstName: 'Jaan', lastName: 'Tamm' })
    expect(result).toEqual({ ok: true, firstName: 'Jaan', lastName: 'Tamm' })
  })

  test('names the picture after the profile email, not a submitted one', async () => {
    globalThis.readBody = async () => ({
      firstName: 'Jaan', lastName: 'Tamm', email: 'other@example.com',
      photo: { name: 'a.jpg', data: 'data:image/jpeg;base64,/9j/4AAQ' }
    })
    const handler = (await import('../server/api/checkout/profile.post.js')).default
    await handler({})

    const { userPictureBaseName } = await import('../server/utils/userPicture.js')
    expect(globalThis.uploadStrapiImage.mock.calls[0][0].filename).toBe(`${userPictureBaseName('jaan@example.ee', 7)}.jpg`)
    expect(setProfile.mock.calls[0][1]).not.toHaveProperty('email')
    expect(setProfile.mock.calls[0][1].picture).toBe(5)
  })
})

describe('PUT /api/profile', () => {
  test('ignores a multipart email field', async () => {
    const setProfile = vi.fn().mockResolvedValue({})
    globalThis.defineEventHandler = fn => fn
    globalThis.getUserIdFromEvent = () => 7
    globalThis.getStrapiUser = vi.fn().mockResolvedValue({ id: 7, user_profile: { id: 70, email: 'jaan@example.ee' } })
    globalThis.setStrapiUserProfile = setProfile
    globalThis.readMultipartFormData = async () => [
      { name: 'firstName', data: Buffer.from('Jaan') },
      { name: 'email', data: Buffer.from('x@eesti.ee') }
    ]
    strapiMock.setStrapiUserProfile = setProfile
    const handler = (await import('../server/api/profile/index.put.js')).default

    await handler({})

    expect(setProfile.mock.calls[0][1]).toEqual({ firstName: 'Jaan' })
  })
})

describe('GET /api/email state handling', () => {
  const run = async (stateCookie) => {
    const cookies = { state: stateCookie }
    const set = {}
    globalThis.defineEventHandler = fn => fn
    globalThis.useRuntimeConfig = () => ({ public: { oauthClientId: 'c', url: 'http://shop.test', oauthUrl: 'http://oauth.test' } })
    globalThis.getQuery = () => ({ user_token: 'jwt', redirect_uri: 'https://x/checkout?a=1' })
    globalThis.getCookie = (_e, name) => cookies[name]
    globalThis.setCookie = (_e, name, value) => { set[name] = value }
    let location
    globalThis.sendRedirect = (_e, url) => { location = url }
    const handler = (await import('../server/api/email/index.get.js')).default
    await handler({})
    return { set, state: new URL(location).searchParams.get('state') }
  }

  test.each([[undefined], ['null'], ['']])('with state cookie %j the cookie and the URL carry one value', async (cookie) => {
    const { set, state } = await run(cookie)
    expect(state).toMatch(/^[0-9a-f]{32}$/)
    expect(set.state).toBe(state)
  })

  test('keeps a real existing state cookie', async () => {
    const { set, state } = await run('abc123')
    expect(state).toBe('abc123')
    expect(set.state).toBeUndefined()
  })
})

describe('GET /api/email callback', () => {
  const run = async (oauthEmail) => {
    const cookies = { state: 'st', redirect_uri: 'https://x/checkout?a=1', user_token: 'jwt' }
    const set = {}
    let location
    globalThis.defineEventHandler = fn => fn
    globalThis.createError = (o) => Object.assign(new Error(o.statusMessage), o)
    globalThis.useRuntimeConfig = () => ({ public: { oauthClientId: 'c', url: 'http://shop.test', oauthUrl: 'http://oauth.test' }, oauthClientSecret: 's' })
    globalThis.getQuery = () => ({ code: 'c1', state: 'st' })
    globalThis.getCookie = (_e, name) => cookies[name]
    globalThis.setCookie = (_e, name, value) => { set[name] = value }
    globalThis.sendRedirect = (_e, url) => { location = url }
    globalThis.$fetch = vi.fn(async (url) => (String(url).endsWith('/api/token') ? { access_token: 't' } : { email: oauthEmail }))
    globalThis.getUserIdFromToken = async () => 7
    globalThis.getStrapiUser = vi.fn().mockResolvedValue({ id: 7, user_profile: { id: 70, email: 'old@example.ee' } })
    globalThis.emailInUse = vi.fn().mockResolvedValue(false)
    globalThis.setStrapiUserProfile = vi.fn().mockResolvedValue({})
    globalThis.authenticateStrapiUser = vi.fn().mockResolvedValue({ id: 7 })
    const handler = (await import('../server/api/email/index.get.js')).default
    await handler({})
    return { set, location }
  }

  test.each([['38001010000@eesti.ee'], ['38001010000@EESTI.ee']])('refuses the proven address %s: no lookup, no profile write', async (email) => {
    const { set, location } = await run(email)
    expect(location).toBe('https://x/checkout?a=1&notifier=emailChangeUndeliverable')
    expect(set.state).toBeNull()
    expect(globalThis.setStrapiUserProfile).not.toHaveBeenCalled()
    expect(globalThis.emailInUse).not.toHaveBeenCalled()
  })

  test('a real address is still written', async () => {
    const { location } = await run('new@example.ee')
    expect(globalThis.setStrapiUserProfile).toHaveBeenCalledWith(70, { email: 'new@example.ee' })
    expect(location).toBe('https://x/checkout?a=1&notifier=emailChangeSuccess')
  })
})
