import { describe, it, expect, beforeEach } from 'vitest'
import { createStrapiGateway } from '../server/utils/fiona/strapiGateway.js'

const STRAPI = 'http://strapi.test'

function fakeFetch (responses = {}) {
  const calls = []
  const fetch = (url, options = {}) => {
    calls.push({ url, method: options.method || 'GET', headers: options.headers || {}, body: options.body })
    const key = `${options.method || 'GET'} ${url.replace(STRAPI, '')}`
    for (const [pattern, response] of Object.entries(responses)) {
      if (key.startsWith(pattern)) return typeof response === 'function' ? response(options) : response
    }
    return []
  }
  return { fetch, calls }
}

describe('createStrapiGateway', () => {
  let registered
  const deps = () => ({
    config: { strapiUrl: STRAPI },
    getAdminToken: () => 'ADMIN',
    getActiveFionaGuestbooks: () => ['gb-1'],
    authenticateStrapiUser: (email) => { registered.push(email); return { id: '77', email } },
    log: { warn () {}, info () {}, error () {} }
  })

  beforeEach(() => { registered = [] })

  it('reads active rules with relations through the admin token', async () => {
    const { fetch, calls } = fakeFetch({ 'GET /fiona-sync-rules': [{ id: 1 }] })
    const gateway = createStrapiGateway({ fetch, ...deps() })
    expect(await gateway.loadRules()).toEqual([{ id: 1 }])
    expect(calls[0].url).toBe(`${STRAPI}/fiona-sync-rules?active=true&_limit=-1`)
    expect(calls[0].headers.Authorization).toBe('Bearer ADMIN')
  })

  it('lists editions that carry a guestbook id with their validity window', async () => {
    const { fetch, calls } = fakeFetch({
      'GET /festival-editions?guestbook_id_null=false': [
        { id: 86, name_en: 'PÖFF 29', guestbook_id: 'gb-29', validFrom: '2026-01-01T00:00:00.000Z', validUntil: null, other: 'x' }
      ]
    })
    const editions = await createStrapiGateway({ fetch, ...deps() }).listEditionsWithGuestbook()
    expect(calls[0].url).toBe(`${STRAPI}/festival-editions?guestbook_id_null=false&_limit=-1`)
    expect(editions).toEqual([{ id: 86, name: 'PÖFF 29', guestbookId: 'gb-29', validFrom: '2026-01-01T00:00:00.000Z', validUntil: null }])
  })

  it('reads the sync job entry by key and returns null when none exists', async () => {
    const { fetch, calls } = fakeFetch({ 'GET /fiona-sync-jobs?key=accreditations': [{ id: 4, key: 'accreditations', enabled: true }] })
    const gateway = createStrapiGateway({ fetch, ...deps() })
    expect(await gateway.getSyncJob('accreditations')).toEqual({ id: 4, key: 'accreditations', enabled: true })
    expect(calls[0].url).toBe(`${STRAPI}/fiona-sync-jobs?key=accreditations&_limit=1`)
    expect(await gateway.getSyncJob('films')).toBeNull()
  })

  it('saves a job patch with the admin token', async () => {
    const { fetch, calls } = fakeFetch({ 'PUT /fiona-sync-jobs/4': { id: 4 } })
    await createStrapiGateway({ fetch, ...deps() }).saveSyncJob(4, { mutation_cursor: '2026-09-13T10:00:00.000Z', last_error: null })
    expect(calls[0].method).toBe('PUT')
    expect(calls[0].url).toBe(`${STRAPI}/fiona-sync-jobs/4`)
    expect(calls[0].body).toEqual({ mutation_cursor: '2026-09-13T10:00:00.000Z', last_error: null })
    expect(calls[0].headers.Authorization).toBe('Bearer ADMIN')
  })

  it('lists managed people by a non-null fiona_person_id', async () => {
    const { fetch, calls } = fakeFetch()
    await createStrapiGateway({ fetch, ...deps() }).findManagedPeople()
    expect(calls[0].url).toBe(`${STRAPI}/people?fiona_person_id_null=false&_limit=-1`)
  })

  it('looks a person up by fiona id, by email and by id, returning null when absent', async () => {
    const { fetch, calls } = fakeFetch({ 'GET /people?fiona_person_id=': [{ id: 5 }], 'GET /people/9': { id: 9 } })
    const gateway = createStrapiGateway({ fetch, ...deps() })
    expect(await gateway.findPersonByFionaId('abc def')).toEqual({ id: 5 })
    expect(calls[0].url).toBe(`${STRAPI}/people?fiona_person_id=abc%20def&_limit=1`)
    expect(await gateway.findPersonByEmail('a+b@x.ee')).toBeNull()
    expect(calls[1].url).toBe(`${STRAPI}/people?eMail=a%2Bb%40x.ee&_limit=1`)
    expect(await gateway.findPersonById(9)).toEqual({ id: 9 })
  })

  it('returns null for a missing user instead of throwing', async () => {
    const { fetch } = fakeFetch({ 'GET /users/404': () => { const e = new Error('not found'); e.statusCode = 404; throw e } })
    expect(await createStrapiGateway({ fetch, ...deps() }).getUser('404')).toBeNull()
  })

  it('finds an existing user by email without registering', async () => {
    const { fetch } = fakeFetch({ 'GET /users?email=': [{ id: 3, email: 'x@y.ee', person: { id: 8 } }] })
    const result = await createStrapiGateway({ fetch, ...deps() }).findOrRegisterUser('x@y.ee')
    expect(result).toEqual({ user: { id: 3, email: 'x@y.ee', person: { id: 8 } }, created: false })
    expect(registered).toEqual([])
  })

  it('registers a missing user through authenticateStrapiUser and reports created', async () => {
    const { fetch } = fakeFetch({ 'GET /users?email=': [] })
    const result = await createStrapiGateway({ fetch, ...deps() }).findOrRegisterUser('new@y.ee')
    expect(registered).toEqual(['new@y.ee'])
    expect(result.created).toBe(true)
    expect(result.user).toMatchObject({ id: 77, email: 'new@y.ee' })
  })

  it('writes people, links and roles with the admin token', async () => {
    const { fetch, calls } = fakeFetch({ 'POST /people': { id: 11 }, 'PUT /people/11': { id: 11 } })
    const gateway = createStrapiGateway({ fetch, ...deps() })
    await gateway.createPerson({ firstName: 'A', skipbuild: true })
    await gateway.updatePerson(11, { lastName: 'B', skipbuild: true })
    await gateway.linkPersonToUser(11, 3)
    await gateway.setUserRoles(3, [7, 9])
    expect(calls.map(c => `${c.method} ${c.url.replace(STRAPI, '')}`)).toEqual([
      'POST /people', 'PUT /people/11', 'PUT /users/3', 'PUT /users/3'
    ])
    expect(calls[0].body).toEqual({ firstName: 'A', skipbuild: true })
    expect(calls[2].body).toEqual({ person: 11 })
    expect(calls[3].body).toEqual({ user_roles: [7, 9] })
    for (const call of calls) expect(call.headers.Authorization).toBe('Bearer ADMIN')
  })

  it('reads role ids off the user record', async () => {
    const { fetch } = fakeFetch({ 'GET /users/3': { id: 3, user_roles: [{ id: 7 }, { id: 9 }] } })
    expect(await createStrapiGateway({ fetch, ...deps() }).getUserRoleIds(3)).toEqual([7, 9])
  })

  it('creates a user profile only when none exists', async () => {
    const { fetch, calls } = fakeFetch({ 'GET /user-profiles?user=3': [{ id: 1 }], 'GET /user-profiles?user=4': [] })
    const gateway = createStrapiGateway({ fetch, ...deps() })
    expect(await gateway.ensureUserProfile({ id: 3 }, { email: 'a@b.ee' })).toBe(false)
    expect(await gateway.ensureUserProfile({ id: 4 }, { email: 'c@d.ee', firstName: 'C' })).toBe(true)
    const post = calls.find(c => c.method === 'POST')
    expect(post.url).toBe(`${STRAPI}/user-profiles`)
    expect(post.body).toEqual({ user: 4, email: 'c@d.ee', firstName: 'C' })
  })

  it('uploads a photo as multipart and returns the file id', async () => {
    const { fetch, calls } = fakeFetch({ 'POST /upload': [{ id: 55 }] })
    const id = await createStrapiGateway({ fetch, ...deps() }).uploadPhoto(Buffer.from('jpg'), 'fiona-person-1.jpg')
    expect(id).toBe(55)
    expect(calls[0].body).toBeInstanceOf(FormData)
    expect(calls[0].body.get('files')).toBeTruthy()
  })
})
