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

const relationId = value => (value && typeof value === 'object') ? value.id : value

export function createStrapiGateway ({ fetch, config, getAdminToken, getActiveFionaGuestbooks, authenticateStrapiUser, log = console }) {
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

  return {
    async loadRules () {
      return await get('/fiona-sync-rules?active=true&_limit=-1')
    },

    /** The `fiona-sync-job` entry for a job key (cursor, interval, on/off), or null. */
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

    async findOrRegisterUser (email) {
      const existing = first(await get(`/users?email=${encodeURIComponent(email)}`))
      if (existing) return { user: existing, created: false }
      const registered = await authenticateStrapiUser(email)
      return { user: { id: Number(registered.id), email: registered.email || email, person: null }, created: true }
    },

    async getUserRoleIds (userId) {
      const user = await get(`/users/${encodeURIComponent(userId)}`)
      return (Array.isArray(user?.user_roles) ? user.user_roles : []).map(relationId).map(Number)
    },

    async setUserRoles (userId, roleIds) {
      await put(`/users/${encodeURIComponent(userId)}`, { user_roles: [...roleIds] })
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

    async ensureUserProfile (user, fields) {
      const existing = await get(`/user-profiles?user=${encodeURIComponent(user.id)}&_limit=1`)
      if (Array.isArray(existing) && existing.length) return false
      await post('/user-profiles', { user: Number(user.id), ...fields })
      return true
    },

    async uploadPhoto (buffer, filename) {
      const form = new FormData()
      form.append('files', new Blob([buffer], { type: 'image/jpeg' }), filename)
      const uploaded = await post('/upload', form)
      const file = first(uploaded)
      if (!file?.id) log.warn?.(`[fionaSync] photo upload for ${filename} returned no file id`)
      return file?.id ?? null
    }
  }
}
