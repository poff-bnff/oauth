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

// Everything that can point at a person, for the duplicate persons report and the merge: where to read it, and the
// field names that hold a person there (credits sit inside components, so the whole entry is searched for them).
const REFERENCE_PAGE = 100
const PERSON_KEYS = ['person', 'person_of_role']
const REFERENCE_SOURCES = [
  { source: 'awarding', route: '/awardings', keys: ['person'] },
  { source: 'filmography', route: '/filmographies', keys: ['person'] },
  { source: 'client', route: '/clients', keys: ['client_person'] },
  { source: 'dis-camp-person', route: '/dis-camp-people', keys: PERSON_KEYS },
  { source: 'industry-person', route: '/industry-people', keys: PERSON_KEYS },
  { source: 'dis-camp-article', route: '/dis-camp-articles', keys: ['people'] },
  { source: 'industry-article', route: '/industry-articles', keys: ['people'] },
  { source: 'film', route: '/films', keys: PERSON_KEYS },
  { source: 'course', route: '/courses', keys: PERSON_KEYS },
  { source: 'course-event', route: '/course-events', keys: PERSON_KEYS },
  { source: 'dis-camp-project', route: '/dis-camp-projects', keys: PERSON_KEYS },
  { source: 'industry-project', route: '/industry-projects', keys: PERSON_KEYS },
  { source: 'team', route: '/teams', keys: PERSON_KEYS },
  // the festival pass has no REST route of its own: the content manager of the admin reads it
  { source: 'festival-pass', route: '/content-manager/collection-types/application::festival-pass.festival-pass', keys: ['owner'], contentManager: true }
]

/** The REST route of a source that names persons; the festival pass (content manager only) is read, never written, here. */
function creditRoute (source) {
  const found = REFERENCE_SOURCES.find(item => item.source === source)
  if (!found || found.contentManager) throw new Error(`${source} cannot be read or written through a REST route here`)
  return found.route
}

/** The ids of persons in a relation value: a number, an object with an id, or a list of them. */
function personIdsIn (value) {
  if (Array.isArray(value)) return value.flatMap(personIdsIn)
  const id = Number(relationId(value))
  return Number.isFinite(id) && id > 0 ? [id] : []
}

/** Walk an entry and collect the wanted person ids found under the given keys (not looking inside a person itself). */
function collectPersonIds (value, keys, wanted, found) {
  if (Array.isArray(value)) { for (const item of value) collectPersonIds(item, keys, wanted, found); return }
  if (!value || typeof value !== 'object') return
  for (const [key, inner] of Object.entries(value)) {
    if (keys.includes(key)) { for (const id of personIdsIn(inner)) if (wanted.has(id)) found.add(id) } else collectPersonIds(inner, keys, wanted, found)
  }
}

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

    /**
     * Every person whose e-mail is this address, whatever the case of the letters, lowest id first. Strapi's own filter
     * is a case-insensitive "contains", so the hits are narrowed to the exact address here.
     */
    async findPeopleByEmail (email) {
      const wanted = String(email ?? '').trim()
      if (!wanted) return []
      const found = asList(await get(`/people?eMail_contains=${encodeURIComponent(wanted)}&_sort=id:asc&_limit=100`))
      return found
        .filter(person => String(person?.eMail ?? '').trim().toLowerCase() === wanted.toLowerCase())
        .sort((a, b) => Number(a.id) - Number(b.id))
    },

    /** Persons whose full name or last name contains `term`, all pages (at most 2,000), for finding same-name persons. */
    async findPeopleByNameTerm (term) {
      const value = encodeURIComponent(term)
      const clauses = ['firstNameLastName', 'lastName'].map((field, index) => `_where[_or][${index}][${field}_contains]=${value}`)
      const pageSize = 200
      const found = []
      for (let start = 0; start < 2000; start += pageSize) {
        const page = asList(await get(`/people?${clauses.join('&')}&_start=${start}&_limit=${pageSize}&_sort=id:asc`))
        found.push(...page)
        if (page.length < pageSize) break
      }
      return found
    },

    /**
     * Where the given persons are used: { refs: { personId: [{ source, id }] }, covered: [source], failed: [{ source, error }] }.
     * A source that cannot be read is listed in `failed` and not in `covered`: no references there is not the same as unknown.
     */
    async findPersonReferences (personIds) {
      const wanted = new Set(asList(personIds).map(Number).filter(id => Number.isFinite(id) && id > 0))
      const refs = {}
      const covered = []
      const failed = []
      if (!wanted.size) return { refs, covered, failed }
      for (const { source, route, keys, contentManager } of REFERENCE_SOURCES) {
        try {
          for (let page = 0; page < 500; page++) {
            const response = contentManager
              ? await get(`${route}?page=${page + 1}&pageSize=${REFERENCE_PAGE}`)
              : await get(`${route}?_start=${page * REFERENCE_PAGE}&_limit=${REFERENCE_PAGE}&_sort=id:asc`)
            const entries = asList(contentManager && !Array.isArray(response) ? response?.results : response)
            for (const entry of entries) {
              const found = new Set()
              collectPersonIds(entry, keys, wanted, found)
              for (const personId of found) {
                const list = (refs[personId] ||= [])
                if (!list.some(ref => ref.source === source && ref.id === entry.id)) list.push({ source, id: entry.id })
              }
            }
            const pageCount = contentManager && !Array.isArray(response) ? Number(response?.pagination?.pageCount) || 1 : null
            if (pageCount !== null ? page + 1 >= pageCount : entries.length < REFERENCE_PAGE) break
          }
          covered.push(source)
        } catch (err) {
          failed.push({ source, error: err?.message || String(err) })
        }
      }
      return { refs, covered, failed }
    },

    /** An entry that names a person (a film, a team, ...), as its own REST route returns it; null when it does not exist. */
    async getCreditEntry (source, id) {
      return await getOrNull(`${creditRoute(source)}/${encodeURIComponent(id)}`)
    },

    /** Write fields of such an entry (the patch of fiona/personCredits.js). */
    async updateCreditEntry (source, id, payload) {
      return await put(`${creditRoute(source)}/${encodeURIComponent(id)}`, payload)
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

    /** Point an address at another person (the address of a person that is merged into another one). */
    async moveAddressToPerson (addressId, personId) {
      await put(`/addresses/${encodeURIComponent(addressId)}`, { person: Number(personId) })
    },

    async setAddressCountry (addressId, countryId) {
      await put(`/addresses/${encodeURIComponent(addressId)}`, { country: Number(countryId) })
    },

    /** Delete a person for good (a merged person that is no longer needed). */
    async deletePerson (id) {
      return await request('DELETE', `/people/${encodeURIComponent(id)}`)
    },

    async createPerson (payload) {
      return await post('/people', payload)
    },

    async updatePerson (id, payload) {
      return await put(`/people/${encodeURIComponent(id)}`, payload)
    },

    /**
     * Make logins aliases of a main login (hunt's alias feature does the same update). A plain user update without
     * `person`: the user model's hook mails a Creative Gate person only when a person is linked in the same update.
     */
    async setAliasUsers (mainUserId, aliasUserIds) {
      await put(`/users/${encodeURIComponent(mainUserId)}`, { aliasUsers: asList(aliasUserIds).map(Number) })
    },

    /** Take the person off a login (an alias is a login identity only). `person: null` is no person in the update: no mail. */
    async clearUserPerson (userId) {
      await put(`/users/${encodeURIComponent(userId)}`, { person: null })
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
