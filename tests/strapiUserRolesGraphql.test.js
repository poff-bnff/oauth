/**
 * fetchStrapiUserRolesGraphql — the user-roles read that does not load their users.
 *
 * REST GET /user-roles?_limit=-1 loads every user of every role (about 17 MB on 2026-11-12). GraphQL loads only the
 * fields that are asked for, and login needs just each role's id and badge rules.
 */
import { describe, it, expect, vi } from 'vitest'
import jwt from 'jsonwebtoken'
import { fetchStrapiUserRolesGraphql, fetchStrapiUserRolesRest } from '../server/utils/strapi.js'

const ADMIN_JWT = jwt.sign({ id: 1 }, 'test-secret', { expiresIn: '10h' })
const SERVICE_TOKEN = jwt.sign({ id: 16998 }, 'test-secret', { expiresIn: '10h' })

// Routes the two token requests; `graphqlAnswer` gets the request body, `restAnswer` answers the REST roles read.
function mockStrapi ({ graphqlAnswer = () => ({ data: { userRoles: [] } }), restAnswer = () => [] } = {}) {
  globalThis.$fetch = vi.fn().mockImplementation((url, opts = {}) => {
    if (url.endsWith('/auth/local')) return { jwt: SERVICE_TOKEN }
    if (url.includes('/admin/login')) return { data: { token: ADMIN_JWT } }
    if (url.endsWith('/graphql')) return graphqlAnswer(opts.body)
    if (url.includes('/user-roles')) return restAnswer()
    throw new Error(`unexpected ${url}`)
  })
  const callsTo = part => globalThis.$fetch.mock.calls.filter(([url]) => url.includes(part))
  return { callsTo }
}

describe('fetchStrapiUserRolesGraphql', () => {
  it('asks /graphql, as the admin, for the id and the badge rules of every role - and for no users', async () => {
    const roles = [{ id: 7, user_badges: [{ badgeName: 'Press', badgeStatuses: 'Approved' }] }, { id: 3, user_badges: [] }]
    const { callsTo } = mockStrapi({ graphqlAnswer: () => ({ data: { userRoles: roles } }) })

    expect(await fetchStrapiUserRolesGraphql()).toEqual(roles)

    const [[url, opts]] = callsTo('/graphql')
    expect(url).toBe('http://localhost:1337/graphql')
    expect(opts.method).toBe('POST')
    expect(opts.headers.Authorization).toBe(`Bearer ${ADMIN_JWT}`)
    expect(opts.body.query).toMatch(/userRoles\s*\{/)
    expect(opts.body.query).toMatch(/\bid\b/)
    expect(opts.body.query).toMatch(/user_badges\s*\{\s*badgeName\s+badgeStatuses\s*\}/)
    expect(opts.body.query).not.toMatch(/\busers\b/)
  })

  it('throws the GraphQL error messages so a wrong field name is visible, not silent', async () => {
    mockStrapi({ graphqlAnswer: () => ({ errors: [{ message: 'Cannot query field "userRoles" on type "Query".' }, { message: 'second' }] }) })

    await expect(fetchStrapiUserRolesGraphql()).rejects.toThrow('graphql: Cannot query field "userRoles" on type "Query".; second')
  })

  it('throws when the answer has no list of roles', async () => {
    mockStrapi({ graphqlAnswer: () => ({ data: { userRoles: null } }) })

    await expect(fetchStrapiUserRolesGraphql()).rejects.toThrow('graphql: no userRoles in the answer')
  })
})

describe('fetchStrapiUserRolesRest', () => {
  it('reads /user-roles?_limit=-1 every time it is called, with no cache (for the one-off comparison)', async () => {
    const { callsTo } = mockStrapi({ restAnswer: () => [{ id: 1 }] })

    await fetchStrapiUserRolesRest()
    await fetchStrapiUserRolesRest()

    expect(callsTo('/user-roles')).toHaveLength(2)
    expect(callsTo('/user-roles')[0][0]).toContain('_limit=-1')
  })
})
