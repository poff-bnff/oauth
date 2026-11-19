/**
 * Mode `roleAudit` of POST /api/sync/fiona — read-only: who holds a badge that earns a Strapi role, and do they still have the role and
 * the Fiona MyPoff link? The audit itself is tested in fionaRoleAudit.test.js; this keeps the way in honest: the route knows the mode and
 * roleId, runFionaSync answers it with the real clients (Strapi gateway + XAPI client, every request a GET) and it is never refused by the
 * run lock, so it can be asked while a sync run is going.
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

beforeEach(async () => {
  requests = []
  globalThis.useRuntimeConfig = () => ({ strapiUrl: 'http://strapi.test', fionaApiKey: 'test-key' })
  globalThis.$fetch = (url, options = {}) => {
    requests.push({ url, method: options.method || 'GET' })
    if (url.endsWith('/guestbook/gb-1/accreditations')) return Promise.resolve([{ Id: 'a1' }, { Id: 'a2' }])
    if (url.endsWith('/accreditation/a1/badges')) return Promise.resolve([{ GuestbookBadge: { Id: 'b1', Description: 'Team' }, Status: { Description: 'Printed' } }])
    if (url.endsWith('/accreditation/a2/badges')) return Promise.resolve([{ GuestbookBadge: { Id: 'b2', Description: 'Hundipass' }, Status: { Description: 'Printed' } }])
    if (url.endsWith('/accreditation/a1')) return Promise.resolve({ Person: { Id: 'p1' }, Guestbook: { Id: 'gb-1' } })
    if (url.includes('/person/p1/MyPoff/externalauthentications')) return Promise.resolve([{ externalIdentification: '10' }])
    if (url.endsWith('/users/10')) return Promise.resolve({ id: 10, user_roles: [{ id: 15 }], mainUser: null, person: { id: 7 } })
    return Promise.reject(Object.assign(new Error(`unexpected request ${url}`), { statusCode: 500 }))
  }
  vi.resetModules()
  ;({ runFionaSync } = await import('../server/utils/fionaSync.js'))
})

describe('mode "roleAudit": wiring', () => {
  it('answers the audit with the real clients and sends nothing but GET requests', async () => {
    const result = await runFionaSync({ mode: 'roleAudit', roleId: 15, guestbookIds: ['gb-1'] })

    expect(result).toMatchObject({ mode: 'roleAudit', roleId: 15, guestbookId: 'gb-1', total: 2, qualifying: 1, counts: { 'role-ok': 1 }, skipped: { noRoleBadge: 1 } })
    expect(requests.length).toBeGreaterThan(0)
    expect(requests.every(request => request.method === 'GET')).toBe(true)
  })

  it('needs a role id', async () => {
    await expect(runFionaSync({ mode: 'roleAudit', guestbookIds: ['gb-1'] })).rejects.toThrow(/roleId/)
  })

  it('is answered before the run lock is looked at, so it works while a sync run is going', () => {
    expect(fionaSyncSource.indexOf("mode === 'roleAudit'")).toBeGreaterThan(-1)
    expect(fionaSyncSource.indexOf("mode === 'roleAudit'")).toBeLessThan(fionaSyncSource.indexOf('if (syncRunning)'))
  })

  it('is a mode of the route, with roleId and the paging fields handed on, and documented', () => {
    expect(route).toMatch(/\[[^\]]*'roleAudit'[^\]]*\]\.includes\(body\?\.mode\)/)
    expect(route).toContain('const roleId')
    expect(route).toMatch(/runFionaSync\(\{[^}]*linksOffset[^}]*linksLimit[^}]*roleId/)
    expect(route).toContain('"mode": "roleAudit"')
  })
})
