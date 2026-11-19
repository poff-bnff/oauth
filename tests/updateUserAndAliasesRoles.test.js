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
function mockStrapi ({ roles = ROLES, main, alias, badgesById = {}, badgeErrorsById = {}, guestbooks = [{ guestbook_id: 'gb-1' }], guestbooksError = false } = {}) {
  const puts = []

  globalThis.$fetch = vi.fn().mockImplementation((url, opts = {}) => {
    const method = opts.method || 'GET'

    if (url.endsWith('/auth/local')) return { jwt: SERVICE_TOKEN }
    if (url.includes('/admin/login')) return { data: { token: ADMIN_JWT } }
    if (url.includes('/user-roles')) return roles
    if (url.includes('/festival-editions?')) {
      if (guestbooksError) throw new Error('strapi is down')
      return guestbooks
    }

    const badgeMatch = url.match(/\/MyPoff\/(\d+)\/guestbook\/gb-1\/badges/)
    if (badgeMatch) {
      const status = badgeErrorsById[badgeMatch[1]]
      // what Fiona answers instead of a badge list: 400 = no account under that id (the MyPoff link is gone), 5xx / 429 = trouble
      if (status) throw Object.assign(new Error(`HTTP ${status}`), { statusCode: status })
      return badgesById[badgeMatch[1]] || []
    }

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

  it('times its parts by name, so the slow one can be seen: roles list, guestbooks, each Fiona badge call, the user reads and the writes', async () => {
    const main = makeMain({ user_roles: [] })
    const alias = makeAlias({ user_roles: [] })
    mockStrapi({ main, alias, badgesById: { 41: [{ GuestbookBadge: { Description: 'Press' }, Status: { Description: 'Approved' } }] } })
    const names = []
    const timer = { step: (name, fn) => { names.push(name); return fn() }, detail: () => {} }

    await updateUserAndAliasesRoles(main, { timer })

    expect(names).toEqual([
      'role sync › roles list',
      'role sync › active guestbooks (Strapi)',
      'role sync › Fiona badges call 1/2',
      'role sync › Fiona badges call 2/2',
      'role sync › current user (Strapi)',
      'role sync › update roles (Strapi)',
      'role sync › alias user read (Strapi)'
    ])
  })
  describe('when Fiona cannot be read, a role earned by a badge is not taken away', () => {
    const press = [{ GuestbookBadge: { Description: 'Press' }, Status: { Description: 'Approved' } }]

    it.each([500, 504, 429])('keeps the badge role when the Fiona read answers %i for every id', async (status) => {
      const main = makeMain({ user_roles: [{ id: 7 }, { id: 5 }] })
      const alias = makeAlias({ user_roles: [] })
      const { puts } = mockStrapi({ main, alias, badgeErrorsById: { 42: status, 41: status } })

      await updateUserAndAliasesRoles(main)

      expect(puts).toEqual([])
    })

    it('keeps the badge role when Fiona answers 400 "no account under that id" for every id (the MyPoff link is gone)', async () => {
      const main = makeMain({ user_roles: [{ id: 7 }, { id: 5 }] })
      const alias = makeAlias({ user_roles: [] })
      const { puts } = mockStrapi({ main, alias, badgeErrorsById: { 42: 400, 41: 400 } })

      await updateUserAndAliasesRoles(main)

      expect(puts).toEqual([])
    })

    it('keeps the badge role when ONE read fails, even though the other answered with no badge', async () => {
      const main = makeMain({ user_roles: [{ id: 7 }] })
      const alias = makeAlias({ user_roles: [] })
      const { puts } = mockStrapi({ main, alias, badgeErrorsById: { 41: 500 }, badgesById: { 42: [] } })

      await updateUserAndAliasesRoles(main)

      expect(puts).toEqual([])
    })

    it('keeps the badge role when the active guestbooks cannot be looked up', async () => {
      const main = makeMain({ user_roles: [{ id: 7 }] })
      const alias = makeAlias({ user_roles: [] })
      const { puts } = mockStrapi({ main, alias, guestbooksError: true })

      await updateUserAndAliasesRoles(main)

      expect(puts).toEqual([])
    })

    it('still grants a role a badge proves while another read failed, and keeps the others', async () => {
      const main = makeMain({ user_roles: [{ id: 5 }] })
      const alias = makeAlias({ user_roles: [] })
      const { puts } = mockStrapi({ main, alias, badgeErrorsById: { 42: 500 }, badgesById: { 41: press } })

      await updateUserAndAliasesRoles(main)

      expect(puts).toEqual([{ id: 42, body: { user_roles: [7, 5] } }])
    })

    it('still takes the badge role away when Fiona answered and the person holds no matching badge (the read is trustworthy)', async () => {
      const main = makeMain({ user_roles: [{ id: 7 }, { id: 5 }] })
      const alias = makeAlias({ user_roles: [] })
      const { puts } = mockStrapi({ main, alias, badgesById: { 42: [], 41: [] } })

      await updateUserAndAliasesRoles(main)

      expect(puts).toEqual([{ id: 42, body: { user_roles: [5] } }])
    })

    it('trusts the read when the main id answered and only the alias id is unknown to Fiona (a 400 for an alias is normal)', async () => {
      const main = makeMain({ user_roles: [{ id: 7 }] })
      const alias = makeAlias({ user_roles: [] })
      const { puts } = mockStrapi({ main, alias, badgesById: { 42: [] }, badgeErrorsById: { 41: 400 } })

      await updateUserAndAliasesRoles(main)

      expect(puts).toEqual([{ id: 42, body: { user_roles: [] } }])
    })

    it('still lets badge roles lapse when no guestbook is active any more (the festival is over: nothing is read, nothing is failed)', async () => {
      const main = makeMain({ user_roles: [{ id: 7 }] })
      const alias = makeAlias({ user_roles: [] })
      const { puts } = mockStrapi({ main, alias, guestbooks: [] })

      await updateUserAndAliasesRoles(main)

      expect(puts).toEqual([{ id: 42, body: { user_roles: [] } }])
    })

    it('says in the log that it kept the badge roles, without naming the person by e-mail', async () => {
      const main = makeMain({ user_roles: [{ id: 7 }] })
      const alias = makeAlias({ user_roles: [] })
      mockStrapi({ main, alias, badgeErrorsById: { 42: 500, 41: 500 } })
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

      await updateUserAndAliasesRoles(main)

      const text = warn.mock.calls.flat().join(' ')
      warn.mockRestore()
      expect(text).toMatch(/kept the badge roles/i)
      expect(text).toContain('42')
      expect(text).not.toContain('@')
    })
  })
})
