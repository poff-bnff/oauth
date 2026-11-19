/**
 * Mode `roleRepair` of POST /api/sync/fiona — gives a Strapi role to the logins of the badge holders who lack it. The repair itself is tested in
 * fionaRoleRepair.test.js; this keeps the way in honest: the route knows the mode and makes it a dry run unless dryRun is explicitly false,
 * runFionaSync answers it with the real clients (a dry run sends only GET requests; a real run adds the role with ONE PUT per user and keeps the
 * roles the user has), and the run lock refuses it while a sync run is going (it writes).
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../server/utils/fiona/sync.js', () => ({ runSync: vi.fn() }))
vi.mock('../server/utils/strapi.js', () => ({
  getStrapiAdminToken: vi.fn(() => Promise.resolve('ADMIN')),
  getActiveFionaGuestbooks: vi.fn(),
  getStrapiUser: vi.fn(),
  getStrapiPerson: vi.fn(),
  fetchStrapiUserRolesGraphql: vi.fn(() => Promise.resolve([{ id: 15, user_badges: [{ badgeName: 'Team', badgeStatuses: 'Approved, Delivered, Paid, Printed' }] }])),
  fetchStrapiUserRolesRest: vi.fn()
}))

const read = relative => readFileSync(fileURLToPath(new URL(`../${relative}`, import.meta.url)), 'utf8')
const fionaSyncSource = read('server/utils/fionaSync.js')
const route = read('server/api/sync/fiona.post.js')

let runFionaSync
let requests
let userRoles

beforeEach(async () => {
  requests = []
  userRoles = [{ id: 5 }]
  globalThis.useRuntimeConfig = () => ({ strapiUrl: 'http://strapi.test', fionaApiKey: 'test-key' })
  globalThis.$fetch = (url, options = {}) => {
    const method = options.method || 'GET'
    requests.push({ url, method, body: options.body })
    if (url.endsWith('/guestbook/gb-1/accreditations')) return Promise.resolve([{ Id: 'a1' }])
    if (url.endsWith('/accreditation/a1/badges')) return Promise.resolve([{ GuestbookBadge: { Id: 'b1', Description: 'Team' }, Status: { Description: 'Printed' } }])
    if (url.endsWith('/accreditation/a1')) return Promise.resolve({ Person: { Id: 'p1' }, Guestbook: { Id: 'gb-1' } })
    if (url.includes('/person/p1/MyPoff/externalauthentications')) return Promise.resolve([{ externalIdentification: '10' }])
    if (url.endsWith('/users/10') && method === 'PUT') {
      userRoles = options.body.user_roles.map(id => ({ id }))
      return Promise.resolve({ id: 10 })
    }
    if (url.endsWith('/users/10')) return Promise.resolve({ id: 10, user_roles: userRoles, mainUser: null, blocked: false, person: { id: 7 } })
    return Promise.reject(Object.assign(new Error(`unexpected request ${method} ${url}`), { statusCode: 500 }))
  }
  vi.resetModules()
  ;({ runFionaSync } = await import('../server/utils/fionaSync.js'))
})

describe('mode "roleRepair": wiring', () => {
  it('a dry run lists the user it would grant and sends nothing but GET requests', async () => {
    const result = await runFionaSync({ mode: 'roleRepair', roleId: 15, guestbookIds: ['gb-1'], dryRun: true })

    expect(result).toMatchObject({ mode: 'roleRepair', dryRun: true, planned: 1, granted: 0, users: [{ userId: 10, action: 'would-grant' }] })
    expect(requests.every(request => request.method === 'GET')).toBe(true)
  })

  it('a real run adds the role with one PUT and keeps the roles the user has', async () => {
    const result = await runFionaSync({ mode: 'roleRepair', roleId: 15, guestbookIds: ['gb-1'], dryRun: false })

    expect(result).toMatchObject({ dryRun: false, granted: 1, errors: [] })
    const puts = requests.filter(request => request.method === 'PUT')
    expect(puts).toHaveLength(1)
    expect(puts[0].body).toEqual({ user_roles: [5, 15] })
  })

  it('needs a role id', async () => {
    await expect(runFionaSync({ mode: 'roleRepair', guestbookIds: ['gb-1'], dryRun: true })).rejects.toThrow(/roleId/)
  })

  it('is answered after the run lock is looked at: a write is refused while a sync run is going', () => {
    expect(fionaSyncSource.indexOf("mode === 'roleRepair'")).toBeGreaterThan(fionaSyncSource.indexOf('if (syncRunning)'))
  })

  it('is a mode of the route that is a dry run unless dryRun is explicitly false, with its categories handed on, and documented', () => {
    expect(route).toMatch(/\[[^\]]*'roleRepair'[^\]]*\]\.includes\(body\?\.mode\)/)
    expect(route).toMatch(/const dryRun = \[[^\]]*'roleRepair'[^\]]*\]\.includes\(mode\)/)
    expect(route).toContain('const repairCategories')
    expect(route).toMatch(/runFionaSync\(\{[^}]*roleId, repairCategories/)
    expect(route).toContain('"mode": "roleRepair"')
  })
})
