/**
 * rolesReadReport — read-only probe: can the user-roles be read without their users?
 *
 * GET /user-roles?_limit=-1 loads every user of every role (about 17 MB) and kept Strapi busy on 2026-11-12. Login only needs
 * each role's id and badge rules (user_badges: badgeName + badgeStatuses). The report times a GraphQL read of just those
 * fields and, when asked, compares it once with the REST read so nothing is switched over before the two are known to agree.
 * It reports ids, counts, timings and badge rules (configuration, not personal data) and never throws.
 */
import { describe, it, expect } from 'vitest'
import { rolesReadReport } from '../server/utils/fiona/rolesReadReport.js'

const press = { badgeName: 'Press', badgeStatuses: 'Approved, Printed' }
const guest = { badgeName: 'Guest', badgeStatuses: 'Approved' }

// a reader that answers with a value / fails with a message
const answers = value => () => Promise.resolve(value)
const fails = message => () => Promise.reject(new Error(message))

// a fake clock that moves 40 ms every time it is read
function clock () { let t = 1000; return () => { t += 40; return t } }

describe('rolesReadReport', () => {
  it('times the GraphQL read and counts the roles and the roles that carry badge rules', async () => {
    const graphql = answers([{ id: 7, user_badges: [press] }, { id: 3, user_badges: [] }, { id: 5 }])

    const report = await rolesReadReport({ graphql, now: clock() })

    expect(report.graphql).toEqual({ ok: true, ms: 40, roles: 3, withBadgeRules: 1 })
    expect(report.rest).toBeNull()
    expect(report.comparison).toBeNull()
  })

  it('reports a failed GraphQL read instead of throwing, with the message', async () => {
    const graphql = fails('Cannot query field "userRoles" on type "Query"')

    const report = await rolesReadReport({ graphql, now: clock() })

    expect(report.graphql).toEqual({ ok: false, ms: 40, error: 'Cannot query field "userRoles" on type "Query"' })
  })

  it('treats an empty or malformed GraphQL answer as a failure, because an empty list would strip every role', async () => {
    expect((await rolesReadReport({ graphql: answers([]), now: clock() })).graphql).toMatchObject({ ok: false, error: 'no roles returned' })
    expect((await rolesReadReport({ graphql: answers(null), now: clock() })).graphql).toMatchObject({ ok: false, error: 'no roles returned' })
    expect((await rolesReadReport({ graphql: answers([{ name: 'no id' }]), now: clock() })).graphql).toMatchObject({ ok: false, error: 'a role without an id' })
  })

  it('does not read REST unless a REST reader is given', async () => {
    let restReads = 0
    const rest = () => { restReads++; return Promise.resolve([]) }

    await rolesReadReport({ graphql: answers([{ id: 1 }]), now: clock() })
    expect(restReads).toBe(0)

    await rolesReadReport({ graphql: answers([{ id: 1 }]), rest, now: clock() })
    expect(restReads).toBe(1)
  })

  it('says the two agree when ids and badge rules match, whatever the order and the extra fields REST carries', async () => {
    const graphql = answers([{ id: 7, user_badges: [press, guest] }, { id: 3, user_badges: [] }])
    const rest = answers([
      { id: 3, name: 'Other', users: [{ id: 1, email: 'someone@example.ee' }], user_badges: [] },
      { id: 7, name: 'Press', users: [{ id: 2 }], user_badges: [{ ...guest, id: 9 }, { ...press, id: 8 }] }
    ])

    const report = await rolesReadReport({ graphql, rest, now: clock() })

    expect(report.rest).toEqual({ ok: true, ms: 40, roles: 2, withBadgeRules: 1 })
    expect(report.comparison).toEqual({ equal: true, onlyInRest: [], onlyInGraphql: [], differentRules: [] })
  })

  it('treats a role without user_badges and a role with an empty list alike', async () => {
    const report = await rolesReadReport({ graphql: answers([{ id: 5 }]), rest: answers([{ id: 5, user_badges: [] }]), now: clock() })

    expect(report.comparison.equal).toBe(true)
  })

  it('lists roles found on one side only and roles whose badge rules differ, by id, with the rules but never user data', async () => {
    const graphql = answers([{ id: 7, user_badges: [press] }, { id: 11, user_badges: [] }, { id: 3, user_badges: [] }])
    const rest = answers([
      { id: 7, user_badges: [{ badgeName: 'Press', badgeStatuses: 'Approved' }], users: [{ id: 1, email: 'someone@example.ee' }] },
      { id: 3, user_badges: [] },
      { id: 12, user_badges: [] }
    ])

    const report = await rolesReadReport({ graphql, rest, now: clock() })

    expect(report.comparison).toEqual({
      equal: false,
      onlyInRest: [12],
      onlyInGraphql: [11],
      differentRules: [{ id: 7, graphql: ['Press|Approved,Printed'], rest: ['Press|Approved'] }]
    })
    expect(JSON.stringify(report)).not.toContain('someone@example.ee')
  })

  it('still reports the GraphQL side when REST fails, and compares nothing', async () => {
    const report = await rolesReadReport({ graphql: answers([{ id: 1 }]), rest: fails('504 Gateway Time-out'), now: clock() })

    expect(report.graphql.ok).toBe(true)
    expect(report.rest).toEqual({ ok: false, ms: 40, error: '504 Gateway Time-out' })
    expect(report.comparison).toBeNull()
  })
})
