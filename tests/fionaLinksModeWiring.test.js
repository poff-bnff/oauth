/**
 * Mode `links` of POST /api/sync/fiona — read-only: does Fiona still hold the MyPoff login link of the persons the sync manages?
 * The audit itself is tested in fionaLinkAudit.test.js; this keeps the way in honest: the route knows the mode and its paging
 * fields, runFionaSync answers it with real clients (Strapi gateway + XAPI client, every request a GET), and it is never refused
 * by the run lock (like `attention`), so it can be asked while a sync run is going.
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
  fetchStrapiUserRolesGraphql: vi.fn(),
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
    if (url.endsWith('/people/5')) return Promise.resolve({ id: 5, fiona_person_id: 'fp-5', user: { id: 10 } })
    if (url.endsWith('/users/10')) return Promise.resolve({ id: 10, mainUser: null })
    if (url.includes('/person/fp-5/MyPoff/externalauthentications')) return Promise.resolve([{ externalIdentification: '10' }])
    return Promise.reject(Object.assign(new Error(`unexpected request ${url}`), { statusCode: 500 }))
  }
  vi.resetModules()
  ;({ runFionaSync } = await import('../server/utils/fionaSync.js'))
})

describe('mode "links": wiring', () => {
  it('answers the audit of the given persons with the real clients and sends nothing but GET requests', async () => {
    const result = await runFionaSync({ mode: 'links', personIds: [5] })

    expect(result).toMatchObject({ mode: 'links', audited: 1, counts: { 'linked-ok': 1 } })
    expect(requests.length).toBeGreaterThan(0)
    expect(requests.every(request => request.method === 'GET')).toBe(true)
  })

  it('is answered before the run lock is looked at, so it works while a sync run is going', () => {
    expect(fionaSyncSource.indexOf("mode === 'links'")).toBeGreaterThan(-1)
    expect(fionaSyncSource.indexOf("mode === 'links'")).toBeLessThan(fionaSyncSource.indexOf('if (syncRunning)'))
  })

  it('is a mode of the route, with the paging fields offset and limit handed on to the audit', () => {
    expect(route).toMatch(/\[[^\]]*'links'[^\]]*\]\.includes\(body\?\.mode\)/)
    expect(route).toContain('const linksOffset')
    expect(route).toContain('const linksLimit')
    expect(route).toMatch(/runFionaSync\(\{[^}]*linksOffset[^}]*linksLimit/)
    expect(route).toContain('"mode": "links"')
  })
})
