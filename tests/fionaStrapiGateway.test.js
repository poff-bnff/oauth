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

  it('lists all job entries with a key, lowest id first, so a second entry is noticed', async () => {
    const { fetch, calls } = fakeFetch({ 'GET /fiona-sync-jobs?key=accreditations': [{ id: 1, enabled: true }, { id: 2, enabled: false }] })
    const jobs = await createStrapiGateway({ fetch, ...deps() }).getSyncJobs('accreditations')
    expect(jobs.map(j => j.id)).toEqual([1, 2])
    expect(calls[0].url).toBe(`${STRAPI}/fiona-sync-jobs?key=accreditations&_sort=id:asc&_limit=5`)
    expect(await createStrapiGateway({ fetch: fakeFetch().fetch, ...deps() }).getSyncJobs('films')).toEqual([])
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

  it('creates a missing user directly as confirmed with the authenticated role, never through the register route', async () => {
    const { fetch, calls } = fakeFetch({
      'GET /users?email=': [],
      'POST /users': { id: 78, email: 'new@y.ee', confirmed: true }
    })
    const result = await createStrapiGateway({ fetch, ...deps() }).findOrRegisterUser('new@y.ee')
    expect(registered).toEqual([]) // authenticateStrapiUser (register route + confirmation mail) is NOT used
    expect(result.created).toBe(true)
    expect(result.user).toMatchObject({ id: 78, email: 'new@y.ee' })
    const post = calls.find(c => c.method === 'POST')
    expect(post.url).toBe(`${STRAPI}/users`)
    expect(post.body).toMatchObject({ email: 'new@y.ee', username: 'new@y.ee', confirmed: true, provider: 'local' })
    expect(post.body.role).toBeUndefined() // Strapi assigns the default (authenticated) role itself
    expect(typeof post.body.password).toBe('string')
    expect(post.body.password.length).toBeGreaterThanOrEqual(32)
    expect(post.headers.Authorization).toBe('Bearer ADMIN')
  })

  it('marks an existing unconfirmed user as confirmed when asked', async () => {
    const { fetch, calls } = fakeFetch({ 'PUT /users/3': { id: 3, confirmed: true } })
    await createStrapiGateway({ fetch, ...deps() }).confirmUser(3)
    expect(calls[0].method).toBe('PUT')
    expect(calls[0].url).toBe(`${STRAPI}/users/3`)
    expect(calls[0].body).toEqual({ confirmed: true })
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

  it('creates a user profile when none exists', async () => {
    const { fetch, calls } = fakeFetch({ 'GET /user-profiles?user=4': [] })
    const gateway = createStrapiGateway({ fetch, ...deps() })
    expect(await gateway.ensureUserProfile({ id: 4 }, { email: 'c@d.ee', firstName: 'C' })).toEqual({ created: true, updated: [] })
    const post = calls.find(c => c.method === 'POST')
    expect(post.url).toBe(`${STRAPI}/user-profiles`)
    expect(post.body).toEqual({ user: 4, email: 'c@d.ee', firstName: 'C' })
  })

  it('fills only the empty fields of an existing profile and never overwrites filled ones', async () => {
    const { fetch, calls } = fakeFetch({
      'GET /user-profiles?user=3': [{ id: 1, email: 'a@b.ee', firstName: '', lastName: null, phoneNr: '+372 1' }],
      'PUT /user-profiles/1': { id: 1 }
    })
    const gateway = createStrapiGateway({ fetch, ...deps() })
    const result = await gateway.ensureUserProfile({ id: 3 }, { email: 'a@b.ee', firstName: 'A', lastName: 'B', phoneNr: '+372 999' })
    expect(result).toEqual({ created: false, updated: ['firstName', 'lastName'] })
    const put = calls.find(c => c.method === 'PUT')
    expect(put.url).toBe(`${STRAPI}/user-profiles/1`)
    expect(put.body).toEqual({ firstName: 'A', lastName: 'B' })
  })

  it('leaves a complete existing profile untouched', async () => {
    const { fetch, calls } = fakeFetch({ 'GET /user-profiles?user=3': [{ id: 1, email: 'a@b.ee', firstName: 'A', lastName: 'B' }] })
    const gateway = createStrapiGateway({ fetch, ...deps() })
    expect(await gateway.ensureUserProfile({ id: 3 }, { email: 'a@b.ee', firstName: 'X', lastName: 'Y' })).toEqual({ created: false, updated: [] })
    expect(calls.filter(c => c.method !== 'GET')).toEqual([])
  })

  it('finds an unused earlier upload of a photo by its file name: one that no person uses', async () => {
    const { fetch, calls } = fakeFetch({
      'GET /upload/files': [{ id: 4, name: 'fiona-person-x.jpg' }, { id: 5, name: 'fiona-person-x.jpg' }],
      'GET /people?picture=4': [{ id: 70 }],
      'GET /people?picture=5': []
    })
    const id = await createStrapiGateway({ fetch, ...deps() }).findOrphanPhoto('fiona-person-x.jpg')
    expect(id).toBe(5)
    expect(calls[0].url).toBe(`${STRAPI}/upload/files?name=fiona-person-x.jpg&_limit=10`)
    expect(calls.map(c => c.url)).toContain(`${STRAPI}/people?picture=4&_limit=1`)
    expect(calls.every(c => c.headers.Authorization === 'Bearer ADMIN')).toBe(true)
  })

  it('finds nothing when every file of that name is in use, or there is none', async () => {
    const used = fakeFetch({ 'GET /upload/files': [{ id: 4, name: 'a.jpg' }], 'GET /people?picture=4': [{ id: 70 }] })
    expect(await createStrapiGateway({ fetch: used.fetch, ...deps() }).findOrphanPhoto('a.jpg')).toBeNull()
    const none = fakeFetch({ 'GET /upload/files': [] })
    expect(await createStrapiGateway({ fetch: none.fetch, ...deps() }).findOrphanPhoto('b.jpg')).toBeNull()
  })

  it('treats a failing lookup as "no unused upload" instead of failing the sync', async () => {
    const fetch = () => { throw new Error('Strapi hiccup') }
    expect(await createStrapiGateway({ fetch, ...deps() }).findOrphanPhoto('fiona-person-x.jpg')).toBeNull()
  })

  it('replaces the file of an existing media entry in place when given its id', async () => {
    const { fetch, calls } = fakeFetch({ 'POST /upload?id=55': [{ id: 55, name: 'R_Mari_Maasikas' }] })
    const id = await createStrapiGateway({ fetch, ...deps() }).uploadPhoto(Buffer.from('jpg'), 'R_Mari_Maasikas.jpg', { replaceId: 55 })
    expect(id).toBe(55)
    expect(calls[0].url).toBe(`${STRAPI}/upload?id=55`)
    expect(calls[0].body.get('files').name).toBe('R_Mari_Maasikas.jpg')
  })

  it('uploads a photo as multipart and returns the file id', async () => {
    const { fetch, calls } = fakeFetch({ 'POST /upload': [{ id: 55 }] })
    const id = await createStrapiGateway({ fetch, ...deps() }).uploadPhoto(Buffer.from('jpg'), 'fiona-person-1.jpg')
    expect(id).toBe(55)
    expect(calls[0].body).toBeInstanceOf(FormData)
    expect(calls[0].body.get('files')).toBeTruthy()
  })
})

describe('createStrapiGateway lookups for the extra Fiona values', () => {
  const deps = () => ({ config: { strapiUrl: STRAPI }, getAdminToken: () => 'ADMIN', getActiveFionaGuestbooks: () => [], log: { warn () {}, info () {}, error () {} } })

  it('lists countries, industry categories and roles once per gateway, in full', async () => {
    const { fetch, calls } = fakeFetch({
      'GET /countries': [{ id: 7, name_en: 'Poland', name_et: 'Poola', code: 'PL', other: 'x' }],
      'GET /industry-categories': [{ id: 1, name: 'Discovery Campus', description: 'long text' }],
      'GET /role-at-films': [{ id: 11, order: 5, roleNamePrivate: 'Producer (private)', roleName: { id: 3, en: 'Producer', et: 'Produtsent', ru: '' } }]
    })
    const gateway = createStrapiGateway({ fetch, ...deps() })

    expect(await gateway.listCountries()).toEqual([{ id: 7, name_en: 'Poland', code: 'PL' }])
    expect(await gateway.listIndustryCategories()).toEqual([{ id: 1, name: 'Discovery Campus' }])
    expect(await gateway.listRoleAtFilms()).toEqual([{ id: 11, order: 5, names: ['Producer', 'Produtsent', 'Producer (private)'] }])
    await gateway.listCountries()
    await gateway.listRoleAtFilms()

    expect(calls.map(call => call.url.replace(STRAPI, ''))).toEqual(['/countries?_limit=-1', '/industry-categories?_limit=-1', '/role-at-films?_limit=-1'])
  })

  it('finds organisations by name in every name field, public or not', async () => {
    const { fetch, calls } = fakeFetch({ 'GET /organisations': [{ id: 5, name_en: 'in.kind', namePrivate: null, name_et: 'in.kind', name_ru: undefined, public: false }] })

    const found = await createStrapiGateway({ fetch, ...deps() }).findOrganisationsByName('in.kind & Co')

    expect(found).toEqual([{ id: 5, names: ['in.kind', 'in.kind'] }])
    const url = decodeURIComponent(calls[0].url)
    expect(url).toContain('_where[_or][0][name_en_contains]=in.kind & Co')
    expect(url).toContain('_where[_or][1][namePrivate_contains]=in.kind & Co')
    expect(url).toContain('_where[_or][2][name_et_contains]=in.kind & Co')
    expect(url).toContain('_where[_or][3][name_ru_contains]=in.kind & Co')
    expect(url).not.toContain('public=')
  })

  it('creates an organisation that is not public yet, with the name in both name fields', async () => {
    const { fetch, calls } = fakeFetch({ 'POST /organisations': { id: 321, name_en: 'in.kind' } })

    const id = await createStrapiGateway({ fetch, ...deps() }).createOrganisation({ name: 'in.kind' })

    expect(id).toBe(321)
    expect(calls[0].url).toBe(`${STRAPI}/organisations`)
    expect(calls[0].body).toEqual({ name_en: 'in.kind', namePrivate: 'in.kind', public: false })
  })

  it('reads the country of the address from the person, or from the address record when the person only carries its id', async () => {
    const { fetch, calls } = fakeFetch({ 'GET /addresses/40': { id: 40, country: { id: 7 } }, 'GET /addresses/41': { id: 41, country: null } })
    const gateway = createStrapiGateway({ fetch, ...deps() })

    expect(await gateway.getPersonAddressCountryId({ addr_coll: { id: 9, country: { id: 7 } } })).toBe(7)
    expect(await gateway.getPersonAddressCountryId({ addr_coll: { id: 9, country: null } })).toBeNull()
    expect(await gateway.getPersonAddressCountryId({ addr_coll: null })).toBeNull()
    expect(calls).toEqual([])
    expect(await gateway.getPersonAddressCountryId({ addr_coll: { id: 40 } })).toBe(7)
    expect(await gateway.getPersonAddressCountryId({ addr_coll: 41 })).toBeNull()
    expect(calls.map(call => call.url.replace(STRAPI, ''))).toEqual(['/addresses/40', '/addresses/41'])
  })

  it('creates the address with the country when the person has none, or fills the country of an address without one', async () => {
    const { fetch, calls } = fakeFetch({ 'POST /addresses': { id: 50 }, 'PUT /addresses/9': { id: 9 } })
    const gateway = createStrapiGateway({ fetch, ...deps() })

    await gateway.setPersonAddressCountry({ id: 100, addr_coll: null }, 7)
    await gateway.setPersonAddressCountry({ id: 101, addr_coll: { id: 9 } }, 8)

    expect(calls.map(call => `${call.method} ${call.url.replace(STRAPI, '')} ${JSON.stringify(call.body)}`)).toEqual([
      'POST /addresses {"country":7,"person":100}',
      'PUT /addresses/9 {"country":8}'
    ])
  })
})
