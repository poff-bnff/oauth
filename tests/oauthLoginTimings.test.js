/**
 * GET /api/auth/oauth — the login callback. It must keep doing what it did (exchange the code, find the Strapi user, sync the roles
 * from the Fiona badges, redirect with a JWT) and now also records how long each step took, for the read-only `timings` probe.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import jwt from 'jsonwebtoken'
import { recentTimings, clearTimings } from '../server/utils/fiona/timingLog.js'

globalThis.defineEventHandler = handler => handler
globalThis.getQuery = vi.fn()
globalThis.getCookie = vi.fn()
globalThis.setCookie = vi.fn()
globalThis.sendRedirect = vi.fn((event, url) => ({ redirect: url }))
globalThis.getUserIdFromEvent = vi.fn()
globalThis.authenticateStrapiUser = vi.fn()
globalThis.getStrapiUser = vi.fn()
globalThis.updateUserAndAliasesRoles = vi.fn()

const handler = (await import('../server/api/auth/oauth.get.js')).default
const event = {}

beforeEach(() => {
  vi.clearAllMocks()
  clearTimings()
  getQuery.mockReturnValue({ code: 'c', state: 's' })
  getCookie.mockImplementation((e, name) => ({ state: 's', redirect_uri: 'https://industry.poff.ee/?jwt=' })[name])
  getUserIdFromEvent.mockImplementation(() => { throw new Error('no session') })
  globalThis.$fetch = vi.fn(url => (String(url).endsWith('/api/token') ? Promise.resolve({ access_token: 't' }) : Promise.resolve({ email: 'someone@example.ee' })))
  authenticateStrapiUser.mockResolvedValue({ id: '17745', email: 'someone@example.ee' })
  getStrapiUser.mockResolvedValue({ id: 17745 })
  updateUserAndAliasesRoles.mockResolvedValue({})
})

describe('GET /api/auth/oauth', () => {
  it('still redirects with a JWT for the Strapi user after the role sync', async () => {
    const result = await handler(event)

    expect(updateUserAndAliasesRoles).toHaveBeenCalledWith({ id: 17745 })
    const token = result.redirect.replace('https://industry.poff.ee/?jwt=', '')
    expect(jwt.decode(token).sub).toBe('17745')
  })

  it('records how long each step of the login took, under the Strapi user id, without any e-mail', async () => {
    await handler(event)

    const [entry] = recentTimings()
    expect(entry).toMatchObject({ kind: 'login', userId: '17745', source: 'oauth', ok: true })
    expect(entry.steps.map(step => step.name)).toEqual([
      'token exchange (OAuth provider)',
      'user info (OAuth provider)',
      'Strapi authenticate',
      'role sync (Fiona badges + Strapi)'
    ])
    expect(JSON.stringify(entry)).not.toContain('someone@example.ee')
  })

  it('does not fail the login when the role sync fails, and shows that step as failed', async () => {
    updateUserAndAliasesRoles.mockRejectedValue(new Error('Fiona is down'))

    const result = await handler(event)

    expect(result.redirect).toContain('https://industry.poff.ee/?jwt=')
    expect(recentTimings()[0].steps.find(step => step.name.startsWith('role sync'))).toMatchObject({ failed: true })
  })

  it('refuses a callback with a wrong state and records nothing', async () => {
    getQuery.mockReturnValue({ code: 'c', state: 'other' })

    await expect(handler(event)).rejects.toMatchObject({ statusCode: 400 })

    expect(recentTimings()).toEqual([])
  })
})
