/**
 * roleRepair — mode `roleRepair`: gives a Strapi user-role (e.g. 15 "Industry 2026 participant") to the logins of the persons who hold a
 * badge the role's own rule accepts but do not have the role (roleAudit finds them). It does what the login-time badge check would do,
 * without waiting for a login and without the Fiona MyPoff link. A dry run unless dryRun is explicitly false; it only ADDS the role (every role
 * the user has stays), never touches a blocked user or an alias, writes once per user, and checks each write by reading the user back.
 */
import { describe, it, expect } from 'vitest'
import { roleRepair } from '../server/utils/fiona/roleRepair.js'

const STATUSES = 'Approved, Delivered, Paid, Printed'
const ROLE = { id: 15, user_badges: [{ badgeName: 'Team', badgeStatuses: STATUSES }] }
const badge = (badgeName, statusText) => ({ badgeId: `b-${badgeName}`, badgeName, statusText })
const link = id => ({ provider: 'MyPoff', externalIdentification: String(id) })
const holder = (n, overrides = {}) => ({ acc: `a${n}`, person: `p${n}`, badges: [badge('Team', 'Printed')], email: `h${n}@example.com`, link: [link(10 * n)], ...overrides })

/**
 * users: live, mutable records { id, email, user_roles: [{id}], mainUser, blocked }; writes go to setUserRoles and change them.
 * failWrites: user ids whose write throws; dropRole: user ids whose write is "accepted" but changes nothing (the read-back must catch it)
 */
function deps ({ holders = [], users = [], role = ROLE, failWrites = [], dropRole = [] } = {}) {
  const writes = []
  const byAcc = new Map(holders.map(item => [item.acc, item]))
  const byPerson = new Map(holders.map(item => [item.person, item]))
  return {
    writes,
    users,
    loadRole: roleId => Promise.resolve(Number(roleId) === role.id ? role : null),
    strapi: {
      getActiveGuestbookIds: () => Promise.resolve(['gb-1']),
      getUser: id => Promise.resolve(users.find(candidate => candidate.id === Number(id)) || null),
      findUsersByEmail: email => Promise.resolve(users.filter(candidate => candidate.email === email)),
      setUserRoles: (id, roleIds) => {
        writes.push({ id: Number(id), roleIds: [...roleIds] })
        if (failWrites.includes(Number(id))) return Promise.reject(new Error('HTTP 500'))
        if (!dropRole.includes(Number(id))) users.find(candidate => candidate.id === Number(id)).user_roles = roleIds.map(roleId => ({ id: roleId }))
        return Promise.resolve()
      }
    },
    xapi: {
      listAccreditations: () => Promise.resolve(holders.map(item => ({ id: item.acc })).sort((a, b) => a.id.localeCompare(b.id))),
      getAccreditationBadges: acc => Promise.resolve(byAcc.get(acc)?.badges || []),
      getAccreditation: acc => Promise.resolve({ personId: byAcc.get(acc)?.person || '' }),
      getPerson: personId => Promise.resolve({ email: byPerson.get(personId)?.email || null }),
      getRaw: (path) => {
        const answer = byPerson.get(decodeURIComponent(path.split('/')[2]))?.link
        if (typeof answer === 'number') return Promise.reject(Object.assign(new Error(`HTTP ${answer}`), { statusCode: answer }))
        return Promise.resolve(answer ?? [])
      }
    }
  }
}
const u = (id, { roles = [], mainUser = null, blocked = false, email = `h${id / 10}@example.com` } = {}) => ({ id, email, user_roles: roles.map(roleId => ({ id: roleId })), mainUser, blocked })
const repair = async (setup, options = {}) => {
  const d = deps(setup)
  const report = await roleRepair({ roleId: 15, loadRole: d.loadRole, strapi: d.strapi, xapi: d.xapi, log: { warn () {}, info () {} }, ...options })
  return { report, writes: d.writes, users: d.users }
}
const rolesOf = (users, id) => users.find(candidate => candidate.id === id).user_roles.map(item => item.id).sort((a, b) => a - b)

describe('roleRepair', () => {
  it('is a dry run unless dryRun is explicitly false: it lists what it would grant and writes nothing', async () => {
    const { report, writes, users } = await repair({ holders: [holder(1), holder(2)], users: [u(10, { roles: [5] }), u(20)] })

    expect(writes).toEqual([])
    expect(report).toMatchObject({ dryRun: true, planned: 2, granted: 0 })
    expect(report.users).toEqual([
      { userId: 10, action: 'would-grant', categories: ['linked-role-missing'] },
      { userId: 20, action: 'would-grant', categories: ['linked-role-missing'] }
    ])
    expect(rolesOf(users, 10)).toEqual([5])
  })

  it('grants the role and keeps every role the user already has, then reads the user back to check', async () => {
    const { report, writes, users } = await repair({ holders: [holder(1)], users: [u(10, { roles: [5, 7] })] }, { dryRun: false })

    expect(writes).toEqual([{ id: 10, roleIds: [5, 7, 15] }])
    expect(rolesOf(users, 10)).toEqual([5, 7, 15])
    expect(report).toMatchObject({ dryRun: false, granted: 1, planned: 0, errors: [] })
    expect(report.users).toEqual([{ userId: 10, action: 'granted', categories: ['linked-role-missing'] }])
  })

  it('also repairs a person with no Fiona link, through the Strapi user found by e-mail', async () => {
    const { report, users } = await repair({ holders: [holder(1, { link: 404 })], users: [u(10, { roles: [], email: 'h1@example.com' })] }, { dryRun: false })

    expect(rolesOf(users, 10)).toEqual([15])
    expect(report.users[0]).toMatchObject({ userId: 10, action: 'granted', categories: ['unlinked-role-missing'] })
  })

  it('grants the main login, never an alias, when the e-mail finds an alias', async () => {
    const users = [u(11, { mainUser: { id: 10 }, email: 'h1@example.com' }), u(10, { email: 'main@example.com' })]
    const { writes } = await repair({ holders: [holder(1, { link: 404 })], users }, { dryRun: false })

    expect(writes.map(write => write.id)).toEqual([10])
  })

  it('leaves alone what it cannot be sure of: several logins with the e-mail, none, a link to a missing user, a failed read', async () => {
    const users = [u(30, { email: 'h3@example.com' }), u(31, { email: 'h3@example.com' })]
    const { report, writes } = await repair({
      holders: [holder(2, { link: 404 }), holder(3, { link: 404 }), holder(4, { link: [link(999)] })],
      users
    }, { dryRun: false })

    expect(writes).toEqual([])
    expect(report.granted).toBe(0)
    expect(report.notRepairable).toMatchObject({ 'unlinked-no-user': 1, 'unlinked-several-users': 1, 'linked-to-missing-user': 1 })
  })

  it('does not write for a user who already has the role, and counts it', async () => {
    const { report, writes } = await repair({ holders: [holder(1)], users: [u(10, { roles: [15] })] }, { dryRun: false })

    expect(writes).toEqual([])
    expect(report.granted).toBe(0)
  })

  it('never touches a blocked user', async () => {
    const { report, writes } = await repair({ holders: [holder(1)], users: [u(10, { blocked: true })] }, { dryRun: false })

    expect(writes).toEqual([])
    expect(report.skipped).toMatchObject({ blocked: 1 })
  })

  it('writes once per user even when two persons or two accreditations lead to the same login', async () => {
    const { report, writes } = await repair({
      holders: [holder(1), holder(2, { link: [link(10)] })],
      users: [u(10)]
    }, { dryRun: false })

    expect(writes).toHaveLength(1)
    expect(report.granted).toBe(1)
  })

  it('records a failed write, goes on with the next user, and does not count it as granted', async () => {
    const { report, users } = await repair({ holders: [holder(1), holder(2)], users: [u(10), u(20)], failWrites: [10] }, { dryRun: false })

    expect(report.granted).toBe(1)
    expect(report.errors).toEqual([{ userId: 10, error: 'HTTP 500' }])
    expect(rolesOf(users, 20)).toEqual([15])
  })

  it('does not count a write that Strapi accepted but did not keep: the read-back says so', async () => {
    const { report } = await repair({ holders: [holder(1)], users: [u(10)], dropRole: [10] }, { dryRun: false })

    expect(report.granted).toBe(0)
    expect(report.errors[0]).toMatchObject({ userId: 10 })
    expect(report.errors[0].error).toMatch(/read back/i)
  })

  it('can be limited to some categories (only those with no Fiona link, say)', async () => {
    const { writes, users } = await repair({
      holders: [holder(1), holder(2, { link: 404 })],
      users: [u(10), u(20, { email: 'h2@example.com' })]
    }, { dryRun: false, categories: ['unlinked-role-missing'] })

    expect(writes.map(write => write.id)).toEqual([20])
    expect(rolesOf(users, 10)).toEqual([])
  })

  it('reads a page at a time like the audit, and says where the next one starts', async () => {
    const holders = [1, 2, 3, 4, 5].map(n => holder(n))
    const users = [1, 2, 3, 4, 5].map(n => u(10 * n))

    const { report } = await repair({ holders, users }, { offset: 2, limit: 2 })

    expect(report).toMatchObject({ roleId: 15, total: 5, offset: 2, limit: 2, nextOffset: 4, audited: 2, planned: 2 })
  })

  it('holds no names or e-mails in its answer', async () => {
    const { report } = await repair({ holders: [holder(1), holder(2, { link: 404 })], users: [u(10), u(20, { email: 'h2@example.com' })] }, { dryRun: false })

    expect(JSON.stringify(report)).not.toMatch(/@|example\.com/)
  })

  it('writes nothing when it is a dry run, whatever the categories: only read methods are called', async () => {
    const d = deps({ holders: [holder(1)], users: [u(10)] })
    const strapi = { ...d.strapi, setUserRoles: () => { throw new Error('a dry run must not write') } }

    await expect(roleRepair({ roleId: 15, loadRole: d.loadRole, strapi, xapi: d.xapi, log: { warn () {}, info () {} } })).resolves.toMatchObject({ planned: 1 })
  })
})
