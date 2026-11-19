/**
 * roleAudit — read-only probe (mode `roleAudit`): who in the active guestbook holds a badge that earns a Strapi user-role (the role's
 * own badge rule, e.g. role 15 "Industry 2026 participant"), and does that person still have the role and the Fiona MyPoff login link?
 * The role is given only by hunt's login-time badge check, so "has the badge, no role" means the person has not logged in since, or lost
 * it; combined with the link (a 404 from Fiona = no link) it shows which. Ids and categories only: no names or e-mails.
 */
import { describe, it, expect } from 'vitest'
import { roleAudit } from '../server/utils/fiona/roleAudit.js'

const STATUSES = 'Approved, Delivered, Paid, Printed'
const ROLE = { id: 15, user_badges: [{ badgeName: 'Team', badgeStatuses: STATUSES }, { badgeName: 'Management', badgeStatuses: STATUSES }] }

const badge = (badgeName, statusText) => ({ badgeId: `b-${badgeName}`, badgeName, statusText })
const link = id => ({ provider: 'MyPoff', externalIdentification: String(id) })
const user = (id, { roles = [], mainUser = null, person = null } = {}) => ({ id, email: `u${id}@example.com`, user_roles: roles.map(roleId => ({ id: roleId })), mainUser, person })

/**
 * holders: [{ acc, person, badges, email, link }] — link: array | status number | Error (what Fiona answers for the MyPoff link)
 * Only read methods exist, so a write by the audit would be a TypeError.
 */
function deps ({ holders = [], users = [], role = ROLE, activeGuestbooks = ['gb-1'] } = {}) {
  const calls = { accreditation: [], person: [], raw: [], getUser: [], byEmail: [] }
  const byAcc = new Map(holders.map(holder => [holder.acc, holder]))
  const byPerson = new Map(holders.map(holder => [holder.person, holder]))
  return {
    calls,
    loadRole: roleId => Promise.resolve(role && Number(roleId) === role.id ? role : null),
    strapi: {
      getActiveGuestbookIds: () => Promise.resolve(activeGuestbooks),
      getUser: (id) => { calls.getUser.push(Number(id)); return Promise.resolve(users.find(candidate => candidate.id === Number(id)) || null) },
      findUsersByEmail: (email) => { calls.byEmail.push(email); return Promise.resolve(users.filter(candidate => candidate.email === email)) }
    },
    xapi: {
      listAccreditations: () => Promise.resolve(holders.map(holder => ({ id: holder.acc })).sort((a, b) => a.id.localeCompare(b.id))),
      getAccreditationBadges: (acc) => { const holder = byAcc.get(acc); return holder?.failBadges ? Promise.reject(new Error('HTTP 500')) : Promise.resolve(holder?.badges || []) },
      getAccreditation: (acc) => { calls.accreditation.push(acc); return Promise.resolve({ personId: byAcc.get(acc)?.person || '' }) },
      getPerson: (personId) => { calls.person.push(personId); return Promise.resolve({ email: byPerson.get(personId)?.email || null }) },
      getRaw: (path) => {
        calls.raw.push(path)
        const holder = byPerson.get(decodeURIComponent(path.split('/')[2]))
        const answer = holder?.link
        if (typeof answer === 'number') return Promise.reject(Object.assign(new Error(`HTTP ${answer}`), { statusCode: answer }))
        if (answer instanceof Error) return Promise.reject(answer)
        return Promise.resolve(answer ?? [])
      }
    }
  }
}

const audit = async (setup, options = {}) => {
  const d = deps(setup)
  const report = await roleAudit({ roleId: 15, loadRole: d.loadRole, strapi: d.strapi, xapi: d.xapi, log: { warn () {}, info () {} }, ...options })
  return { report, calls: d.calls }
}
const categoryOf = (report, fionaPersonId) => report.persons.find(item => item.fionaPersonId === fionaPersonId)?.category
const holder = (n, overrides = {}) => ({ acc: `a${n}`, person: `p${n}`, badges: [badge('Team', 'Printed')], email: `h${n}@example.com`, link: [link(10 * n)], ...overrides })

describe('roleAudit', () => {
  it('counts a badge holder who is linked and has the role as role-ok, and does not list them', async () => {
    const { report } = await audit({ holders: [holder(1)], users: [user(10, { roles: [15] })] })

    expect(report.counts['role-ok']).toBe(1)
    expect(report.persons).toEqual([])
    expect(report).toMatchObject({ roleId: 15, guestbookId: 'gb-1', total: 1, audited: 1, qualifying: 1 })
  })

  it('skips an accreditation whose badge the role does not know, with no further Fiona or Strapi call', async () => {
    const { report, calls } = await audit({ holders: [holder(1, { badges: [badge('Hundipass +', 'Printed')] })] })

    expect(report.skipped).toMatchObject({ noRoleBadge: 1 })
    expect(report.qualifying).toBe(0)
    expect(calls.accreditation).toEqual([])
  })

  it('skips a role badge whose status the role does not allow (Requested)', async () => {
    const { report, calls } = await audit({ holders: [holder(1, { badges: [badge('Team', 'Requested')] })] })

    expect(report.skipped).toMatchObject({ status: 1 })
    expect(calls.accreditation).toEqual([])
  })

  it('matches badge names and statuses the way the login does: trimmed, any letter case, statuses from a comma list', async () => {
    const { report } = await audit({ holders: [holder(1, { badges: [badge(' management ', 'DELIVERED')] })], users: [user(10, { roles: [15] })] })

    expect(report.counts['role-ok']).toBe(1)
  })

  it('lists a linked person whose user has no such role: linked-role-missing', async () => {
    const { report } = await audit({ holders: [holder(1)], users: [user(10, { roles: [5], person: { id: 77 } })] })

    expect(categoryOf(report, 'p1')).toBe('linked-role-missing')
    expect(report.persons[0]).toMatchObject({ accreditationId: 'a1', fionaPersonId: 'p1', linkedUserId: 10, userId: 10, strapiPersonId: 77, badges: ['Team (Printed)'] })
  })

  it('looks at the MAIN login when the link is an alias (the login gives badge roles to the main account only)', async () => {
    const users = [user(10, { roles: [], mainUser: { id: 9 } }), user(9, { roles: [15] })]
    const { report } = await audit({ holders: [holder(1)], users })

    expect(report.counts['role-ok']).toBe(1)
  })

  it('lists a link to a Strapi user that does not exist: linked-to-missing-user', async () => {
    const { report } = await audit({ holders: [holder(1, { link: [link(99)] })], users: [] })

    expect(categoryOf(report, 'p1')).toBe('linked-to-missing-user')
  })

  it('finds the Strapi user by e-mail when Fiona has no link (404): unlinked-role-missing, and unlinked-role-ok when the role is there', async () => {
    const users = [{ ...user(21, { roles: [5] }), email: 'h1@example.com' }, { ...user(22, { roles: [15] }), email: 'h2@example.com' }]
    const { report } = await audit({ holders: [holder(1, { link: 404 }), holder(2, { link: [] })], users })

    expect(categoryOf(report, 'p1')).toBe('unlinked-role-missing')
    expect(categoryOf(report, 'p2')).toBe('unlinked-role-ok')
    expect(report.persons.find(item => item.fionaPersonId === 'p1')).toMatchObject({ fionaAnswer: 'status-404', userId: 21 })
    expect(report.persons.find(item => item.fionaPersonId === 'p2')).toMatchObject({ fionaAnswer: 'empty', userId: 22 })
  })

  it('looks at the MAIN login when the user found by e-mail is an alias (badge roles only live on the main login)', async () => {
    const users = [
      { ...user(21, { roles: [], mainUser: { id: 20 } }), email: 'h1@example.com' },
      user(20, { roles: [15] }),
      { ...user(23, { roles: [], mainUser: { id: 22 } }), email: 'h2@example.com' },
      user(22, { roles: [5] })
    ]
    const { report } = await audit({ holders: [holder(1, { link: 404 }), holder(2, { link: 404 })], users })

    expect(categoryOf(report, 'p1')).toBe('unlinked-role-ok')
    expect(report.persons.find(item => item.fionaPersonId === 'p1').userId).toBe(20)
    expect(categoryOf(report, 'p2')).toBe('unlinked-role-missing')
    expect(report.persons.find(item => item.fionaPersonId === 'p2').userId).toBe(22)
  })

  it('says so when an unlinked person has no Strapi user, several, or no e-mail in Fiona', async () => {
    const users = [{ ...user(31, { roles: [] }), email: 'h2@example.com' }, { ...user(32, { roles: [15] }), email: 'h2@example.com' }]
    const { report } = await audit({
      holders: [holder(1, { link: 404 }), holder(2, { link: 404 }), holder(3, { link: 404, email: null })],
      users
    })

    expect(categoryOf(report, 'p1')).toBe('unlinked-no-user')
    expect(categoryOf(report, 'p2')).toBe('unlinked-several-users')
    expect(report.persons.find(item => item.fionaPersonId === 'p2').userIds).toEqual([31, 32])
    expect(categoryOf(report, 'p3')).toBe('unlinked-no-email')
  })

  it('never calls a failed read "unlinked": a 500 on the link, or on the badges, is fiona-error', async () => {
    const { report } = await audit({ holders: [holder(1, { link: 500 }), holder(2, { failBadges: true })], users: [user(10, { roles: [] })] })

    expect(categoryOf(report, 'p1')).toBe('fiona-error')
    expect(report.persons.find(item => item.fionaPersonId === 'p1').error).toMatch(/500/)
    expect(report.counts['fiona-error']).toBe(2)
    expect(report.counts['unlinked-no-user']).toBeUndefined()
  })

  it('audits a person once even when two accreditations of the page qualify, and reads each Strapi user once', async () => {
    const { report, calls } = await audit({
      holders: [holder(1), holder(1, { acc: 'a1b' })].map(item => ({ ...item, person: 'p1' })),
      users: [user(10, { roles: [15] })]
    })

    expect(report.qualifying).toBe(1)
    expect(calls.getUser.filter(id => id === 10)).toHaveLength(1)
  })

  it('reads a page at a time (accreditations, sorted) and says where the next one starts', async () => {
    const holders = [1, 2, 3, 4, 5].map(n => holder(n))
    const users = [1, 2, 3, 4, 5].map(n => user(10 * n, { roles: [15] }))

    const { report, calls } = await audit({ holders, users }, { offset: 2, limit: 2 })

    expect(report).toMatchObject({ total: 5, offset: 2, limit: 2, audited: 2, nextOffset: 4, qualifying: 2 })
    expect(calls.accreditation).toEqual(['a3', 'a4'])
    expect((await audit({ holders, users }, { offset: 4, limit: 2 })).report.nextOffset).toBeNull()
  })

  it('refuses a page of more than 40, an unknown role, and a festival with no active guestbook', async () => {
    await expect(audit({ holders: [] }, { limit: 41 })).rejects.toThrow(/at most 40/)
    await expect(audit({ holders: [] }, { roleId: 99 })).rejects.toThrow(/role 99/)
    await expect(audit({ holders: [], activeGuestbooks: [] })).rejects.toThrow(/guestbook/)
  })

  it('audits the guestbook it is told to', async () => {
    const { report } = await audit({ holders: [], activeGuestbooks: ['gb-1'] }, { guestbookId: 'gb-9' })

    expect(report.guestbookId).toBe('gb-9')
  })

  it('holds no names, e-mails or other personal data in its answer', async () => {
    const users = [{ ...user(21, { roles: [5] }), email: 'h1@example.com' }]
    const { report } = await audit({ holders: [holder(1, { link: 404 }), holder(2, { link: [link(99)] })], users })

    expect(JSON.stringify(report)).not.toMatch(/@|example\.com/)
  })
})
