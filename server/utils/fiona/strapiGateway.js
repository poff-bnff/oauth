/**
 * fiona/strapiGateway.js
 *
 * The Strapi side of the sync's dependency interface (see fiona/sync.js).
 * Every call uses the admin token, which bypasses users-permissions on
 * content routes, so no role configuration is needed for new collections.
 *
 * Injected: `fetch` ($fetch-compatible), `config.strapiUrl`, `getAdminToken`,
 * `getActiveFionaGuestbooks`, `authenticateStrapiUser` — so the module has
 * no Nuxt globals and can be tested with fakes.
 */

import crypto from 'crypto'

const relationId = value => (value && typeof value === 'object') ? value.id : value

export function createStrapiGateway ({ fetch, config, getAdminToken, getActiveFionaGuestbooks, log = console }) {
  if (typeof fetch !== 'function') throw new Error('createStrapiGateway: fetch is required')
  const base = config.strapiUrl

  async function request (method, path, body) {
    const token = await getAdminToken()
    const options = { method, headers: { Authorization: `Bearer ${token}` } }
    if (body !== undefined) {
      options.body = body
      if (!(body instanceof FormData)) options.headers['Content-Type'] = 'application/json'
    }
    return await fetch(`${base}${path}`, options)
  }

  const get = path => request('GET', path)
  const post = (path, body) => request('POST', path, body)
  const put = (path, body) => request('PUT', path, body)

  const getOrNull = async (path) => {
    try {
      return await get(path)
    } catch (err) {
      if (err?.statusCode === 404 || err?.status === 404 || err?.response?.status === 404) return null
      throw err
    }
  }

  const first = list => (Array.isArray(list) && list.length ? list[0] : null)
  const asList = value => (Array.isArray(value) ? value : [])

  // lists that do not change during a run (countries, categories, roles) are read once per gateway
  const once = new Map()
  const readOnce = async (key, load) => {
    if (!once.has(key)) once.set(key, await load())
    return once.get(key)
  }

  return {
    async loadRules () {
      return await get('/fiona-sync-rules?active=true&_limit=-1')
    },

    /** The `fiona-sync-job` entry for a job key (cursor, interval, on/off), or null. */
    /** All job entries with this key, lowest id first: more than one is a mistake the sync reports. */
    async getSyncJobs (key) {
      const list = await getOrNull(`/fiona-sync-jobs?key=${encodeURIComponent(key)}&_sort=id:asc&_limit=5`)
      return Array.isArray(list) ? list : []
    },

    async getSyncJob (key) {
      return first(await getOrNull(`/fiona-sync-jobs?key=${encodeURIComponent(key)}&_limit=1`)) // 404 = collection not created yet
    },

    async saveSyncJob (id, patch) {
      return await put(`/fiona-sync-jobs/${encodeURIComponent(id)}`, patch)
    },

    async getActiveGuestbookIds () {
      return await getActiveFionaGuestbooks()
    },

    /** Every edition that carries a guestbook id, with its validity window (diagnostics). */
    async listEditionsWithGuestbook () {
      const editions = await get('/festival-editions?guestbook_id_null=false&_limit=-1')
      return (Array.isArray(editions) ? editions : []).map(edition => ({
        id: edition.id,
        name: edition.name_en || edition.name_et || String(edition.id),
        guestbookId: edition.guestbook_id,
        validFrom: edition.validFrom ?? null,
        validUntil: edition.validUntil ?? null
      }))
    },

    async findManagedPeople () {
      const people = await get('/people?fiona_person_id_null=false&_limit=-1')
      return Array.isArray(people) ? people : []
    },

    async findPersonByFionaId (fionaPersonId) {
      return first(await get(`/people?fiona_person_id=${encodeURIComponent(fionaPersonId)}&_limit=1`))
    },

    async findPersonByEmail (email) {
      return first(await get(`/people?eMail=${encodeURIComponent(email)}&_limit=1`))
    },

    async findPersonById (id) {
      return await getOrNull(`/people/${encodeURIComponent(id)}`)
    },

    async getUser (id) {
      return await getOrNull(`/users/${encodeURIComponent(id)}`)
    },

    /**
     * Find the login user by email or create it. Creation goes through the admin
     * user route (`POST /users`), NOT `/auth/local/register`: the user is created
     * as confirmed and Strapi sends no confirmation mail. Strapi assigns the
     * default (authenticated) role and hashes the random password.
     */
    async findOrRegisterUser (email) {
      const existing = first(await get(`/users?email=${encodeURIComponent(email)}`))
      if (existing) return { user: existing, created: false }
      const created = await post('/users', {
        username: email,
        email,
        password: crypto.randomBytes(32).toString('hex'),
        confirmed: true,
        provider: 'local',
        externalProviders: [{ provider: 'local', UUID: 'not set yet', dateConnected: new Date().toISOString() }]
      })
      return { user: { id: Number(created.id), email: created.email || email, person: null, confirmed: true }, created: true }
    },

    /** Mark a user as confirmed (identity established through Fiona). */
    async confirmUser (userId) {
      await put(`/users/${encodeURIComponent(userId)}`, { confirmed: true })
    },

    async getUserRoleIds (userId) {
      const user = await get(`/users/${encodeURIComponent(userId)}`)
      return (Array.isArray(user?.user_roles) ? user.user_roles : []).map(relationId).map(Number)
    },

    async setUserRoles (userId, roleIds) {
      await put(`/users/${encodeURIComponent(userId)}`, { user_roles: [...roleIds] })
    },

    /** Strapi countries (English name for matching). */
    async listCountries () {
      return await readOnce('countries', async () => asList(await get('/countries?_limit=-1')).map(country => ({ id: country.id, name_en: country.name_en, code: country.code })))
    },

    /** Strapi industry categories (the list behind Programme/category). */
    async listIndustryCategories () {
      return await readOnce('industry-categories', async () => asList(await get('/industry-categories?_limit=-1')).map(({ id, name }) => ({ id, name })))
    },

    /** Strapi roles at films with every name they carry (English first), for matching an occupation. */
    async listRoleAtFilms () {
      return await readOnce('role-at-films', async () => asList(await get('/role-at-films?_limit=-1')).map(role => ({
        id: role.id,
        order: role.order,
        names: [role.roleName?.en, role.roleName?.et, role.roleName?.ru, role.roleNamePrivate].filter(name => typeof name === 'string' && name.trim())
      })))
    },

    /** Organisations whose name contains `name` in any name field, public or not (the sync decides which one is the same). */
    async findOrganisationsByName (name) {
      const value = encodeURIComponent(name)
      const clauses = ['name_en', 'namePrivate', 'name_et', 'name_ru'].map((field, index) => `_where[_or][${index}][${field}_contains]=${value}`)
      const found = asList(await get(`/organisations?${clauses.join('&')}&_limit=30`))
      return found.map(org => ({ id: org.id, names: [org.name_en, org.namePrivate, org.name_et, org.name_ru].filter(text => typeof text === 'string' && text.trim()) }))
    },

    /** A new organisation from a company name in Fiona. Not public: no half-empty organisation page until someone ticks it. */
    async createOrganisation ({ name }) {
      const created = await post('/organisations', { name_en: name, namePrivate: name, public: false })
      return Number(created.id)
    },

    /** The id of the country in the person's address, null when there is no address or no country in it. */
    async getPersonAddressCountryId (person) {
      const address = person?.addr_coll
      if (!address) return null
      if (typeof address === 'object' && 'country' in address) return address.country ? Number(relationId(address.country)) : null
      const record = await getOrNull(`/addresses/${encodeURIComponent(relationId(address))}`)
      return record?.country ? Number(relationId(record.country)) : null
    },

    /** Put the country into the person's address: fill an address that has none, or create the address. */
    async setPersonAddressCountry (person, countryId) {
      const address = person?.addr_coll
      if (address) await put(`/addresses/${encodeURIComponent(relationId(address))}`, { country: Number(countryId) })
      else await post('/addresses', { country: Number(countryId), person: Number(person.id) })
    },

    async createPerson (payload) {
      return await post('/people', payload)
    },

    async updatePerson (id, payload) {
      return await put(`/people/${encodeURIComponent(id)}`, payload)
    },

    async linkPersonToUser (personId, userId) {
      await put(`/users/${encodeURIComponent(userId)}`, { person: Number(personId) })
    },

    /**
     * Make sure the user has a user-profile. Strapi creates an (empty) profile
     * on registration, so an existing profile gets its EMPTY fields filled from
     * `fields`; values already present are never overwritten.
     * @returns {{ created: boolean, updated: string[] }}
     */
    async ensureUserProfile (user, fields) {
      const existing = first(await get(`/user-profiles?user=${encodeURIComponent(user.id)}&_limit=1`))
      if (!existing) {
        await post('/user-profiles', { user: Number(user.id), ...fields })
        return { created: true, updated: [] }
      }
      const patch = {}
      for (const [key, value] of Object.entries(fields)) {
        const current = existing[key]
        const empty = current === undefined || current === null || current === ''
        if (empty && value !== undefined && value !== null && value !== '') patch[key] = value
      }
      const updated = Object.keys(patch)
      if (updated.length) await put(`/user-profiles/${encodeURIComponent(existing.id)}`, patch)
      return { created: false, updated }
    },

    /**
     * An unused earlier upload under this file name: a media entry of that name that no person uses as its picture.
     * (Strapi stores the file re-encoded, so size is no reliable check; "no person uses it" is.) Used to pick up the
     * photos of a run that uploaded them but did not attach them. Any failure counts as "none".
     */
    async findOrphanPhoto (filename) {
      try {
        const files = await get(`/upload/files?name=${encodeURIComponent(filename)}&_limit=10`)
        for (const file of (Array.isArray(files) ? files : []).filter(item => item?.name === filename)) {
          const users = await get(`/people?picture=${encodeURIComponent(file.id)}&_limit=1`)
          if (!Array.isArray(users) || users.length === 0) return file.id
        }
        return null
      } catch (err) {
        log.warn?.(`[fionaSync] lookup of an unused upload of ${filename} failed: ${err?.message || err}`)
        return null
      }
    },

    /** Upload a photo; with replaceId the file of that media entry is replaced in place (same id, new name and sizes). */
    async uploadPhoto (buffer, filename, { replaceId = null } = {}) {
      const form = new FormData()
      form.append('files', new Blob([buffer], { type: 'image/jpeg' }), filename)
      const uploaded = await post(replaceId ? `/upload?id=${encodeURIComponent(replaceId)}` : '/upload', form)
      const file = first(uploaded)
      if (!file?.id) log.warn?.(`[fionaSync] photo upload for ${filename} returned no file id`)
      return file?.id ?? null
    }
  }
}
