/**
 * updateUserAndAliasesRoles — syncing Strapi user-roles from Fiona badges at login.
 *
 * A Strapi user can be an alias of a main account (alias.mainUser set, main.aliasUsers lists its
 * aliases). Fiona badges are queried by Strapi user id, and Fiona may hold a guest's badges under
 * their alias id rather than their main id, so badges are fetched for the main id AND every alias
 * id and summed onto one badge list. That summed list grants badge-based roles to the main account;
 * each alias is synced separately (its own existing roles compared against its own record, never
 * the main's), and never gets a badge-based role, only whichever non-badge roles it already has.
 *
 * $fetch is globally mocked in setup.js; mockStrapi below routes every URL the function under test
 * can produce, and throws on anything unexpected so a wrong call fails loudly instead of hanging.
 */
import { describe, it, expect, vi } from 'vitest'
import jwt from 'jsonwebtoken'
import { updateUserAndAliasesRoles } from '../server/utils/strapi.js'

const SERVICE_TOKEN = jwt.sign({ id: 16998 }, 'test-secret', { expiresIn: '1h' })
const ADMIN_JWT = jwt.sign({ id: 1 }, 'test-secret', { expiresIn: '1h' })

// Role 7 is badge-gated on the Press badge; roles 3 and 5 are plain roles kept only if already
// assigned.
const ROLES = [
  { id: 7, user_badges: [{ badgeName: 'Press', badgeStatuses: 'Approved, Printed' }] },
  { id: 3, user_badges: [] },
  { id: 5 }
]

// MAIN owns the profile; ALIAS is a login identity that resolves to MAIN (mainUser set). Factories
// so each test gets its own object — getStrapiUser mutates what it's given (adds .My, strips nulls).
function makeMain (overrides = {}) {
  return {
    id: 42,
    email: 'main@example.ee',
    provider: 'local',
    aliasUsers: [{ id: 41 }],
    user_profile: { firstName: 'Katri' },
    user_roles: [],
    ...overrides
  }
}

function makeAlias (overrides = {}) {
  return {
    id: 41,
    email: 'alias@example.ee',
    mainUser: { id: 42 },
    aliasUsers: [],
    user_profile: {},
    user_roles: [],
    ...overrides
  }
}

// Routes every request updateUserAndAliasesRoles can make: the two tokens, the roles list, the
// active-guestbook lookup, Fiona badge fetches (keyed by Strapi user id), the alias lookup
// mergeUserMy makes while loading the main user's own record, and the two user records themselves.
function mockStrapi ({ roles = ROLES, main, alias, badgesById = {} } = {}) {
  const puts = []

  globalThis.$fetch = vi.fn().mockImplementation((url, opts = {}) => {
    const method = opts.method || 'GET'

    if (url.endsWith('/auth/local')) return { jwt: SERVICE_TOKEN }
    if (url.includes('/admin/login')) return { data: { token: ADMIN_JWT } }
    if (url.includes('/user-roles')) return roles
    if (url.includes('/festival-editions?')) return [{ guestbook_id: 'gb-1' }]

    const badgeMatch = url.match(/\/MyPoff\/(\d+)\/guestbook\/gb-1\/badges/)
    if (badgeMatch) return badgesById[badgeMatch[1]] || []

    if (url.includes('/users?id_in=41')) return alias ? [alias] : []

    const byIdMatch = url.match(/\/users\/(\d+)$/)
    if (byIdMatch) {
      const id = byIdMatch[1]
      if (method === 'PUT') {
        puts.push({ id: Number(id), body: opts.body })
        return { id: Number(id), ...opts.body }
      }
      if (main && id === String(main.id)) return main
      if (alias && id === String(alias.id)) return alias
    }

    throw new Error(`unexpected ${method} ${url}`)
  })

  return { puts, calls: () => globalThis.$fetch.mock.calls }
}

const fionaCallsFor = (calls, id) => calls.filter(([url]) => url.includes(`/MyPoff/${id}/guestbook/gb-1/badges`))

describe('updateUserAndAliasesRoles', () => {
  it('grants a badge-only role to the main account when Fiona holds the badge under the alias id', async () => {
    const main = makeMain({ user_roles: [] })
    const alias = makeAlias({ user_roles: [] })
    const { puts, calls } = mockStrapi({
      main,
      alias,
      badgesById: { 41: [{ GuestbookBadge: { Description: 'Press' }, Status: { Description: 'Approved' } }] }
    })

    await updateUserAndAliasesRoles(main)

    expect(puts).toEqual([{ id: 42, body: { user_roles: [7] } }])
    expect(fionaCallsFor(calls(), 42)).toHaveLength(1)
    expect(fionaCallsFor(calls(), 41)).toHaveLength(1)

    const [[rolesUrl]] = calls().filter(([url]) => url.includes('/user-roles'))
    expect(rolesUrl).toContain('_limit=-1')
  })

  it('compares an alias against its own roles, not the main account it resolves to', async () => {
    // Main has role 5; the alias separately has roles 3 and 7. If the alias were (wrongly)
    // resolved to the main account before comparing, this would read main's [5] as "current" and
    // never touch the alias record at all.
    const main = makeMain({ user_roles: [{ id: 5 }] })
    const alias = makeAlias({ user_roles: [{ id: 3 }, { id: 7 }] })
    const { puts } = mockStrapi({ main, alias })

    await updateUserAndAliasesRoles(main)

    expect(puts).toEqual([{ id: 41, body: { user_roles: [3] } }])
  })

  it('keeps a non-badge role already on the alias but never grants it a badge role, even on a badge match', async () => {
    const main = makeMain({ user_roles: [] })
    const alias = makeAlias({ user_roles: [{ id: 3 }] })
    const { puts } = mockStrapi({
      main,
      alias,
      badgesById: { 41: [{ GuestbookBadge: { Description: 'Press' }, Status: { Description: 'Approved' } }] }
    })

    await updateUserAndAliasesRoles(main)

    expect(puts.find(p => p.id === 41)).toBeUndefined()
  })

  it('does not write when the computed roles already match what Strapi has', async () => {
    const main = makeMain({ user_roles: [{ id: 7 }] })
    const alias = makeAlias({ user_roles: [] })
    const { puts } = mockStrapi({
      main,
      alias,
      badgesById: { 42: [{ GuestbookBadge: { Description: 'Press' }, Status: { Description: 'Approved' } }] }
    })

    await updateUserAndAliasesRoles(main)

    expect(puts).toEqual([])
  })

  it('skips role sync entirely when Strapi returns no roles, instead of wiping everyone to []', async () => {
    const main = makeMain({ user_roles: [{ id: 5 }] })
    const alias = makeAlias({ user_roles: [{ id: 3 }] })
    const { puts, calls } = mockStrapi({ main, alias, roles: [] })

    await updateUserAndAliasesRoles(main)

    expect(puts).toEqual([])
    expect(calls().some(([url]) => url.includes('/festival-editions'))).toBe(false)
  })
})
