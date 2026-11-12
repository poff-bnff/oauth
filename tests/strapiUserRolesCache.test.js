/**
 * getStrapiUserRoles — the list of user-roles is read at every login (updateUserAndAliasesRoles). Strapi answers it with
 * every role and what hangs on it (about 17 MB on 2026-11-12) and the roles hardly ever change, so hunt keeps the list
 * for a few minutes, shares one running read between simultaneous logins, and serves an old copy when Strapi fails.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import jwt from 'jsonwebtoken'
import { getStrapiUserRoles } from '../server/utils/strapi.js'

const ADMIN_JWT = jwt.sign({ id: 1 }, 'test-secret', { expiresIn: '10h' })
const SERVICE_TOKEN = jwt.sign({ id: 16998 }, 'test-secret', { expiresIn: '10h' })

const MINUTE = 60 * 1000

// Routes the two token requests and the roles read; `rolesAnswer` is called for every roles read.
function mockStrapi (rolesAnswer) {
  globalThis.$fetch = vi.fn().mockImplementation((url) => {
    if (url.endsWith('/auth/local')) return { jwt: SERVICE_TOKEN }
    if (url.includes('/admin/login')) return { data: { token: ADMIN_JWT } }
    if (url.includes('/user-roles')) return rolesAnswer()
    throw new Error(`unexpected ${url}`)
  })
  return () => globalThis.$fetch.mock.calls.filter(([url]) => url.includes('/user-roles')).length
}

describe('getStrapiUserRoles', () => {
  beforeEach(() => { vi.useFakeTimers({ now: new Date('2026-11-12T15:00:00Z') }) })
  afterEach(() => { vi.useRealTimers() })

  it('reads the roles from Strapi once and answers the next logins from memory', async () => {
    const roles = [{ id: 7 }, { id: 3 }]
    const rolesReads = mockStrapi(() => roles)

    expect(await getStrapiUserRoles()).toEqual(roles)
    expect(await getStrapiUserRoles()).toEqual(roles)
    expect(await getStrapiUserRoles()).toEqual(roles)

    expect(rolesReads()).toBe(1)
  })

  it('reads them again once the copy is ten minutes old', async () => {
    let version = 1
    const rolesReads = mockStrapi(() => [{ id: version }])

    expect(await getStrapiUserRoles()).toEqual([{ id: 1 }])
    version = 2
    vi.advanceTimersByTime(9 * MINUTE)
    expect(await getStrapiUserRoles()).toEqual([{ id: 1 }])
    vi.advanceTimersByTime(2 * MINUTE)
    expect(await getStrapiUserRoles()).toEqual([{ id: 2 }])

    expect(rolesReads()).toBe(2)
  })

  it('shares one read between logins that arrive while it is still running', async () => {
    let release
    const rolesReads = mockStrapi(() => new Promise((resolve) => { release = () => resolve([{ id: 7 }]) }))

    const first = getStrapiUserRoles()
    const second = getStrapiUserRoles()
    const third = getStrapiUserRoles()
    await vi.waitFor(() => expect(rolesReads()).toBe(1))
    release()

    expect(await Promise.all([first, second, third])).toEqual([[{ id: 7 }], [{ id: 7 }], [{ id: 7 }]])
    expect(rolesReads()).toBe(1)
  })

  it('serves the old copy for up to an hour when Strapi fails, then lets the failure through', async () => {
    let fail = false
    mockStrapi(() => { if (fail) throw new Error('504 Gateway Time-out'); return [{ id: 7 }] })

    expect(await getStrapiUserRoles()).toEqual([{ id: 7 }])
    fail = true
    vi.advanceTimersByTime(30 * MINUTE)
    expect(await getStrapiUserRoles()).toEqual([{ id: 7 }])

    vi.advanceTimersByTime(40 * MINUTE)
    await expect(getStrapiUserRoles()).rejects.toThrow('504')
  })

  it('does not remember a failed read: the next login tries again', async () => {
    let calls = 0
    const rolesReads = mockStrapi(() => { calls++; if (calls === 1) throw new Error('504 Gateway Time-out'); return [{ id: 7 }] })

    await expect(getStrapiUserRoles()).rejects.toThrow('504')
    expect(await getStrapiUserRoles()).toEqual([{ id: 7 }])

    expect(rolesReads()).toBe(2)
  })
})
