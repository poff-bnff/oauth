/**
 * linkAudit — read-only probe (mode `links`): for the Fiona persons the sync manages, does Fiona still hold the MyPoff login link
 * (GET /person/{id}/MyPoff/externalauthentications = the Strapi user id Fiona pulled from hunt), and does it still point at the
 * login Strapi knows for that person? Answers with ids and categories only: no names, e-mails or contact details.
 * A failed read is never "unlinked".
 */
import { describe, it, expect } from 'vitest'
import { linkAudit } from '../server/utils/fiona/linkAudit.js'

const person = (id, { fionaId = `fp-${id}`, user = null } = {}) => ({ id, fiona_person_id: fionaId, user, firstName: 'Secret', eMail: 'secret@example.com' })
const user = (id, { mainUser = null } = {}) => ({ id, email: `u${id}@example.com`, mainUser })
const link = externalIdentification => ({ provider: 'MyPoff', externalIdentification: String(externalIdentification) })

/**
 * people: managed Strapi persons; users: Strapi users by id; links: fionaPersonId → array of links | Error | status number
 * Only read methods exist, so a write by the audit would be a TypeError.
 */
function deps ({ people = [], users = [], links = {} } = {}) {
  const calls = { raw: [], getUser: [] }
  return {
    calls,
    strapi: {
      findPersonById: id => Promise.resolve(people.find(candidate => candidate.id === id) || null),
      countManagedPeople: () => Promise.resolve(people.length),
      findManagedPeoplePage: (start, limit) => Promise.resolve([...people].sort((a, b) => a.id - b.id).slice(start, start + limit)),
      getUser: (id) => { calls.getUser.push(id); return Promise.resolve(users.find(candidate => candidate.id === Number(id)) || null) }
    },
    xapi: {
      getRaw: (path) => {
        calls.raw.push(path)
        const fionaId = decodeURIComponent(path.split('/')[2])
        const answer = links[fionaId]
        if (typeof answer === 'number') return Promise.reject(Object.assign(new Error(`HTTP ${answer}`), { statusCode: answer }))
        if (answer instanceof Error) return Promise.reject(answer)
        return Promise.resolve(answer ?? [])
      }
    }
  }
}

const audit = async (setup, options = {}) => {
  const d = deps(setup)
  const report = await linkAudit({ strapi: d.strapi, xapi: d.xapi, log: { warn () {}, info () {} }, ...options })
  return { report, calls: d.calls }
}
const categoryOf = (report, personId) => report.persons.find(item => item.personId === personId)?.category

describe('linkAudit', () => {
  it('counts a person whose Fiona link points at the login Strapi has on the person as linked-ok, and does not list it', async () => {
    const { report } = await audit({ people: [person(1, { user: 10 })], users: [user(10)], links: { 'fp-1': [link(10)] } })

    expect(report.counts['linked-ok']).toBe(1)
    expect(report.persons).toEqual([])
  })

  it('treats a link to the MAIN login of the person\'s alias login as linked-ok (one identity)', async () => {
    const { report } = await audit({
      people: [person(1, { user: 11 })],
      users: [user(10), user(11, { mainUser: { id: 10 } })],
      links: { 'fp-1': [link(10)] }
    })

    expect(report.counts['linked-ok']).toBe(1)
  })

  it('flags a link to a login that is an alias: hunt answers Fiona with the main login at the next sign-in', async () => {
    const { report } = await audit({
      people: [person(1, { user: 10 })],
      users: [user(10), user(11, { mainUser: { id: 10 } })],
      links: { 'fp-1': [link(11)] }
    })

    expect(categoryOf(report, 1)).toBe('linked-to-alias')
    expect(report.persons[0]).toMatchObject({ personId: 1, fionaPersonId: 'fp-1', linkedUserId: 11, userId: 10 })
  })

  it('flags a link to a Strapi user that no longer exists', async () => {
    const { report } = await audit({ people: [person(1, { user: 10 })], users: [user(10)], links: { 'fp-1': [link(99)] } })

    expect(categoryOf(report, 1)).toBe('linked-to-missing-user')
  })

  it('flags a link to another login than the person\'s own (not an alias of it)', async () => {
    const { report } = await audit({ people: [person(1, { user: 10 })], users: [user(10), user(20)], links: { 'fp-1': [link(20)] } })

    expect(categoryOf(report, 1)).toBe('linked-other-user')
  })

  it('flags a linked login when the Strapi person has no login at all', async () => {
    const { report } = await audit({ people: [person(1)], users: [user(20)], links: { 'fp-1': [link(20)] } })

    expect(categoryOf(report, 1)).toBe('linked-person-has-no-user')
  })

  it('calls a person with no Fiona link but a Strapi login repairable, and names the login a repair would use (the main one of an alias)', async () => {
    const { report } = await audit({
      people: [person(1, { user: 11 })],
      users: [user(10), user(11, { mainUser: { id: 10 } })],
      links: { 'fp-1': [] }
    })

    expect(categoryOf(report, 1)).toBe('unlinked-repairable')
    expect(report.persons[0]).toMatchObject({ userId: 11, repairUserId: 10, fionaAnswer: 'empty' })
  })

  it('calls a person with no Fiona link and no Strapi login unlinked-no-user', async () => {
    const { report } = await audit({ people: [person(1)], links: { 'fp-1': [] } })

    expect(categoryOf(report, 1)).toBe('unlinked-no-user')
  })

  it('reads a 404 from Fiona as "no link" but says so, so that the two answers can be told apart', async () => {
    const { report } = await audit({ people: [person(1, { user: 10 })], users: [user(10)], links: { 'fp-1': 404 } })

    expect(categoryOf(report, 1)).toBe('unlinked-repairable')
    expect(report.persons[0].fionaAnswer).toBe('status-404')
  })

  it('never calls a failed Fiona read "unlinked": a 500 is its own category', async () => {
    const { report } = await audit({ people: [person(1, { user: 10 })], users: [user(10)], links: { 'fp-1': 500 } })

    expect(categoryOf(report, 1)).toBe('fiona-error')
    expect(report.counts['unlinked-repairable']).toBeUndefined()
    expect(report.persons[0].error).toMatch(/500/)
  })

  it('notes when Fiona holds more than one link for a person (the sync reads only the first)', async () => {
    const { report } = await audit({
      people: [person(1, { user: 10 })],
      users: [user(10), user(20)],
      links: { 'fp-1': [link(10), link(20)] }
    })

    expect(report.counts['linked-ok']).toBe(1)
    expect(report.multipleLinks).toBe(1)
  })

  it('reads a page at a time and says where the next one starts, so one call never reads every person', async () => {
    const people = [1, 2, 3, 4, 5].map(id => person(id, { user: id * 10 }))
    const users = people.map(item => user(item.user))
    const links = Object.fromEntries(people.map(item => [item.fiona_person_id, [link(item.user)]]))

    const { report, calls } = await audit({ people, users, links }, { offset: 2, limit: 2 })

    expect(report).toMatchObject({ total: 5, offset: 2, limit: 2, audited: 2, nextOffset: 4 })
    expect(calls.raw).toHaveLength(2)
    const last = (await audit({ people, users, links }, { offset: 4, limit: 2 })).report
    expect(last.nextOffset).toBeNull()
  })

  it('audits exactly the given Strapi persons when personIds are sent, and skips ones the sync does not manage', async () => {
    const people = [person(1, { user: 10 }), person(2, { user: 20 }), { id: 3, fiona_person_id: null, user: 30 }]
    const { report, calls } = await audit(
      { people, users: [user(10), user(20)], links: { 'fp-1': [link(10)], 'fp-2': [] } },
      { personIds: [2, 3, 404] }
    )

    expect(calls.raw).toHaveLength(1)
    expect(report.audited).toBe(1)
    expect(report.skipped).toEqual([{ personId: 3, reason: 'not managed by the Fiona sync' }, { personId: 404, reason: 'not found' }])
    expect(categoryOf(report, 2)).toBe('unlinked-repairable')
  })

  it('refuses a page bigger than 100 and a list of more than 100 persons', async () => {
    await expect(audit({ people: [] }, { limit: 101 })).rejects.toThrow(/at most 100/)
    await expect(audit({ people: [] }, { personIds: Array.from({ length: 101 }, (_, i) => i + 1) })).rejects.toThrow(/at most 100/)
  })

  it('holds no names, e-mails or other personal data in its answer', async () => {
    const { report } = await audit({ people: [person(1, { user: 10 }), person(2)], users: [user(10)], links: { 'fp-1': [], 'fp-2': [link(99)] } })

    const text = JSON.stringify(report)
    expect(text).not.toMatch(/secret@example\.com|Secret|u10@example\.com|@/)
  })

  it('reads the Strapi user of a login once even when several persons share it', async () => {
    const { calls } = await audit({
      people: [person(1, { user: 10 }), person(2, { user: 10 })],
      users: [user(10)],
      links: { 'fp-1': [link(10)], 'fp-2': [link(10)] }
    })

    expect(calls.getUser.filter(id => Number(id) === 10)).toHaveLength(1)
  })
})
