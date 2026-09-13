import { describe, it, expect, beforeEach } from 'vitest'
import { runSync } from '../server/utils/fiona/sync.js'

const GB = 'guestbook-2025'
const BADGE_TEAM = 'badge-team-guid'
const BADGE_PRO = 'badge-pro-guid'
const CG = 59
const IND = 90
const ROLE_CG = 7

function silentLog () {
  const lines = { info: [], warn: [], error: [] }
  return {
    lines,
    info: msg => lines.info.push(msg),
    warn: msg => lines.warn.push(msg),
    error: msg => lines.error.push(msg)
  }
}

/** In-memory Fiona: guestbooks → accreditations → badges; persons. */
function fakeFiona () {
  const state = {
    guestbooks: new Map(), // id → { badges:[{id,name}], accreditations:[{id, personId, badges:[...], noPublicationOfContactDetails}] }
    persons: new Map(), // id → { firstName, lastName, email, phone, bio, myPoffUserId, photo }
    failGuestbooks: new Set(),
    failPersons: new Set(),
    knownGuestbooks: null, // null = same as configured guestbooks
    mutations: [] // returned by listMutations regardless of `since`
  }
  const gb = (id) => {
    if (state.failGuestbooks.has(id)) throw new Error(`fiona down for ${id}`)
    return state.guestbooks.get(id) || { badges: [], accreditations: [] }
  }
  const findAcc = (accId) => {
    for (const [gbId, g] of state.guestbooks) {
      const acc = g.accreditations.find(a => a.id === accId)
      if (acc) return { ...acc, guestbookId: gbId }
    }
    throw new Error(`no accreditation ${accId}`)
  }
  return {
    state,
    listGuestbooks () {
      return state.knownGuestbooks || [...state.guestbooks.keys()].map(id => ({ id, name: `Guestbook ${id}` }))
    },
    listGuestbookBadges (id) { return gb(id).badges },
    listAccreditations (id) { return gb(id).accreditations.map(a => ({ id: a.id })) },
    getAccreditationBadges (accId) { return findAcc(accId).badges },
    getAccreditation (accId) {
      const a = findAcc(accId)
      return { personId: a.personId, guestbookId: a.guestbookId, noPublicationOfContactDetails: !!a.noPublicationOfContactDetails, films: [] }
    },
    getPerson (personId) {
      if (state.failPersons.has(personId)) throw new Error(`person ${personId} unavailable`)
      const p = state.persons.get(personId)
      if (!p) throw new Error(`no person ${personId}`)
      return { firstName: p.firstName, lastName: p.lastName, email: p.email, phone: p.phone || null, bio: p.bio || null }
    },
    getMyPoffUserId (personId) { return state.persons.get(personId)?.myPoffUserId || null },
    listMutations (since) { state.lastMutationsSince = since; return [...state.mutations] },
    getAccreditationBadgeRecord (badgeRecordId) {
      for (const g of state.guestbooks.values()) {
        for (const a of g.accreditations) if (a.badges.some(b => b.id === badgeRecordId)) return { accreditationId: a.id }
      }
      throw new Error(`no accreditation badge ${badgeRecordId}`)
    },
    getPersonAccreditations (personId) {
      const out = []
      for (const [gbId, g] of state.guestbooks) for (const a of g.accreditations) if (a.personId === personId) out.push({ id: a.id, guestbookId: gbId })
      return out
    },
    getPersonPhoto (personId) {
      const p = state.persons.get(personId)
      return p?.photo ? { buffer: Buffer.from(p.photo), filename: `fiona-person-${personId}.jpg` } : null
    }
  }
}

/** In-memory Strapi: people, users, profiles, rules, active guestbooks; records every write. */
function fakeStrapi () {
  const state = {
    rules: [],
    activeGuestbookIds: [GB],
    editionsWithGuestbook: [],
    syncJob: null, // { id, key, enabled, incremental_interval_minutes, full_run_hour, mutation_cursor, ... }
    people: new Map(),
    users: new Map(),
    profiles: new Map(), // userId → profile
    uploads: [],
    writes: [],
    nextId: 1000
  }
  const nextId = () => state.nextId++
  const clone = v => JSON.parse(JSON.stringify(v))
  const populated = p => ({ ...clone(p), festival_editions: (p.festival_editions || []).map(id => ({ id })) })
  return {
    state,
    loadRules () { return clone(state.rules) },
    getActiveGuestbookIds () { return [...state.activeGuestbookIds] },
    listEditionsWithGuestbook () { return clone(state.editionsWithGuestbook) },
    getSyncJob (key) { return state.syncJob && state.syncJob.key === key ? clone(state.syncJob) : null },
    saveSyncJob (id, patch) {
      Object.assign(state.syncJob, clone(patch))
      state.writes.push({ op: 'saveSyncJob', id, payload: clone(patch) })
      return clone(state.syncJob)
    },
    findManagedPeople () {
      return [...state.people.values()].filter(p => p.fiona_person_id).map(populated)
    },
    findPersonByFionaId (fid) {
      const p = [...state.people.values()].find(p => p.fiona_person_id === fid)
      return p ? populated(p) : null
    },
    findPersonByEmail (email) {
      const p = [...state.people.values()].find(p => (p.eMail || '').toLowerCase() === email.toLowerCase())
      return p ? populated(p) : null
    },
    findPersonById (id) {
      const p = state.people.get(Number(id))
      return p ? populated(p) : null
    },
    getUser (id) {
      const u = state.users.get(Number(id))
      return u ? clone(u) : null
    },
    confirmUser (userId) {
      state.users.get(Number(userId)).confirmed = true
      state.writes.push({ op: 'confirmUser', id: Number(userId), payload: { confirmed: true } })
    },
    findOrRegisterUser (email) {
      let u = [...state.users.values()].find(u => u.email.toLowerCase() === email.toLowerCase())
      let created = false
      if (!u) {
        u = { id: nextId(), email, person: null, user_roles: [], confirmed: true }
        state.users.set(u.id, u)
        state.writes.push({ op: 'registerUser', id: u.id, payload: { email } })
        created = true
      }
      return { user: clone(u), created }
    },
    getUserRoleIds (userId) { return [...(state.users.get(Number(userId))?.user_roles || [])] },
    setUserRoles (userId, roleIds) {
      state.users.get(Number(userId)).user_roles = [...roleIds]
      state.writes.push({ op: 'setUserRoles', id: Number(userId), payload: { user_roles: [...roleIds] } })
    },
    createPerson (payload) {
      const p = { id: nextId(), ...clone(payload) }
      state.people.set(p.id, p)
      state.writes.push({ op: 'createPerson', id: p.id, payload: clone(payload) })
      return populated(p)
    },
    updatePerson (id, payload) {
      const p = state.people.get(Number(id))
      Object.assign(p, clone(payload))
      state.writes.push({ op: 'updatePerson', id: Number(id), payload: clone(payload) })
      return populated(p)
    },
    linkPersonToUser (personId, userId) {
      state.users.get(Number(userId)).person = Number(personId)
      state.people.get(Number(personId)).user = Number(userId)
      state.writes.push({ op: 'linkPersonToUser', id: Number(userId), payload: { person: Number(personId) } })
    },
    ensureUserProfile (user, fields) {
      const existing = state.profiles.get(Number(user.id))
      if (!existing) {
        state.profiles.set(Number(user.id), { user: Number(user.id), ...fields })
        state.writes.push({ op: 'createProfile', id: Number(user.id), payload: { ...fields } })
        return { created: true, updated: [] }
      }
      const updated = Object.keys(fields).filter(k => (existing[k] === undefined || existing[k] === null || existing[k] === '') && fields[k])
      if (updated.length) {
        for (const k of updated) existing[k] = fields[k]
        state.writes.push({ op: 'updateProfile', id: Number(user.id), payload: Object.fromEntries(updated.map(k => [k, fields[k]])) })
      }
      return { created: false, updated }
    },
    uploadPhoto (buffer, filename) {
      const id = nextId()
      state.uploads.push({ id, filename, size: buffer.length })
      return id
    }
  }
}

function rule (overrides) {
  return {
    id: 1,
    name: 'rule',
    active: true,
    badge_type_id: BADGE_TEAM,
    badge_type_name: 'TEAM',
    sync_statuses: 'pending, created, approved',
    full_profile_statuses: '',
    festival_editions: [],
    user_roles: [],
    ...overrides
  }
}

const TEAM_RULE = rule({ id: 1, name: 'TEAM → basic' })
const PRO_RULE = rule({
  id: 2,
  name: 'Industry PRO → full',
  badge_type_id: BADGE_PRO,
  badge_type_name: 'Industry PRO',
  sync_statuses: 'approved, paid',
  full_profile_statuses: 'approved, paid',
  festival_editions: [{ id: IND }, { id: CG }],
  user_roles: [{ id: ROLE_CG }]
})

function guestbookWith (...accreditations) {
  return {
    badges: [{ id: BADGE_TEAM, name: 'TEAM' }, { id: BADGE_PRO, name: 'Industry PRO' }],
    accreditations
  }
}

function accreditation (id, personId, badgeId, statusText, extra = {}) {
  return { id, personId, badges: [{ badgeId, badgeName: '', statusText }], ...extra }
}

describe('runSync', () => {
  let fiona, strapi, log, deps

  beforeEach(() => {
    fiona = fakeFiona()
    strapi = fakeStrapi()
    log = silentLog()
    deps = { fiona, strapi, log, config: { maxRemovals: 50, maxBuildsPerRun: 20 }, now: () => new Date('2026-09-13T10:00:00.000Z') }
    strapi.state.rules = [TEAM_RULE, PRO_RULE]
  })

  it('level 1: creates user, profile and a basic person with no editions or roles', async () => {
    fiona.state.guestbooks.set(GB, guestbookWith(accreditation('acc1', 'fp1', BADGE_TEAM, 'Created')))
    fiona.state.persons.set('fp1', { firstName: 'Mari', lastName: 'Maasikas', email: 'mari@example.com', phone: '+372 555', bio: 'bio' })

    const stats = await runSync({}, deps)

    const person = [...strapi.state.people.values()][0]
    expect(person).toMatchObject({
      firstName: 'Mari',
      lastName: 'Maasikas',
      firstNameLastName: 'Mari Maasikas',
      eMail: 'mari@example.com',
      phoneNr: '+372 555',
      fiona_person_id: 'fp1',
      fiona_accreditation_id: 'acc1',
      fiona_guestbook_ids: GB,
      fiona_attached_edition_ids: '',
      fiona_assigned_role_ids: ''
    })
    expect(person.festival_editions || []).toEqual([])
    expect(person.bio_en).toBeUndefined()
    const user = [...strapi.state.users.values()][0]
    expect(user.email).toBe('mari@example.com')
    expect(user.person).toBe(person.id)
    expect(user.user_roles).toEqual([])
    expect(strapi.state.profiles.get(user.id)).toMatchObject({ email: 'mari@example.com', firstName: 'Mari', lastName: 'Maasikas' })
    expect(stats.persons).toMatchObject({ desired: 1, created: 1, updated: 0, unpublished: 0 })
    expect(stats.users.created).toBe(1)
    expect(stats.profiles).toEqual({ created: 1, updated: 0 })
  })

  it('reports how many resolved users were unconfirmed or came without the confirmed field', async () => {
    strapi.state.users.set(601, { id: 601, email: 'mari@example.com', person: null, user_roles: [], confirmed: false })
    strapi.state.users.set(602, { id: 602, email: 'jaan@example.com', person: null, user_roles: [] })
    fiona.state.guestbooks.set(GB, guestbookWith(
      accreditation('acc1', 'fp1', BADGE_TEAM, 'Created', { badges: [{ badgeId: BADGE_TEAM, badgeName: '', statusText: 'Created' }] }),
      accreditation('acc2', 'fp2', BADGE_TEAM, 'Created', { badges: [{ badgeId: BADGE_TEAM, badgeName: '', statusText: 'Created' }] })
    ))
    fiona.state.persons.set('fp1', { firstName: 'Mari', lastName: 'Maasikas', email: 'mari@example.com', myPoffUserId: '601' })
    fiona.state.persons.set('fp2', { firstName: 'Jaan', lastName: 'Tamm', email: 'jaan@example.com', myPoffUserId: '602' })

    const stats = await runSync({ dryRun: true }, deps)

    expect(stats.users).toMatchObject({ unconfirmedSeen: 1, confirmedFieldMissing: 1 })
  })

  it('confirms an existing unconfirmed user it links to a synced person', async () => {
    strapi.state.users.set(601, { id: 601, email: 'mari@example.com', person: null, user_roles: [], confirmed: false })
    fiona.state.guestbooks.set(GB, guestbookWith(accreditation('acc1', 'fp1', BADGE_TEAM, 'Created')))
    fiona.state.persons.set('fp1', { firstName: 'Mari', lastName: 'Maasikas', email: 'mari@example.com' })

    const stats = await runSync({}, deps)

    expect(strapi.state.users.get(601).confirmed).toBe(true)
    expect(stats.users.confirmed).toBe(1)
  })

  it('fills the empty names of a profile Strapi created on registration', async () => {
    strapi.state.users.set(600, { id: 600, email: 'mari@example.com', person: null, user_roles: [] })
    strapi.state.profiles.set(600, { user: 600, email: 'mari@example.com', firstName: '', lastName: null })
    fiona.state.guestbooks.set(GB, guestbookWith(accreditation('acc1', 'fp1', BADGE_TEAM, 'Created')))
    fiona.state.persons.set('fp1', { firstName: 'Mari', lastName: 'Maasikas', email: 'mari@example.com' })

    const stats = await runSync({}, deps)

    expect(strapi.state.profiles.get(600)).toMatchObject({ firstName: 'Mari', lastName: 'Maasikas' })
    expect(stats.profiles).toEqual({ created: 0, updated: 1 })
  })

  it('every person write carries skipbuild and the create happens without user or editions', async () => {
    fiona.state.guestbooks.set(GB, guestbookWith(accreditation('acc1', 'fp1', BADGE_PRO, 'approved')))
    fiona.state.persons.set('fp1', { firstName: 'A', lastName: 'B', email: 'a@b.ee' })

    await runSync({}, deps)

    const isBuildTouch = w => Object.keys(w.payload).join() === 'fiona_synced_at'
    const personWrites = strapi.state.writes.filter(w => (w.op === 'createPerson' || w.op === 'updatePerson') && !isBuildTouch(w))
    expect(personWrites.length).toBeGreaterThan(0)
    for (const w of personWrites) expect(w.payload.skipbuild).toBe(true)
    const create = strapi.state.writes.find(w => w.op === 'createPerson')
    expect(create.payload.user).toBeUndefined()
    expect(create.payload.festival_editions).toBeUndefined()
  })

  it('level 2: attaches editions, assigns roles, writes the biography and records what it attached', async () => {
    fiona.state.guestbooks.set(GB, guestbookWith(accreditation('acc2', 'fp2', BADGE_PRO, 'Paid')))
    fiona.state.persons.set('fp2', { firstName: 'Jaan', lastName: 'Tamm', email: 'jaan@example.com', bio: 'Producer from Tallinn', photo: 'jpegbytes' })

    const stats = await runSync({}, deps)

    const person = [...strapi.state.people.values()][0]
    expect(person.festival_editions.sort()).toEqual([CG, IND])
    expect(person.fiona_attached_edition_ids).toBe(`${CG},${IND}`)
    expect(person.fiona_assigned_role_ids).toBe(String(ROLE_CG))
    expect(person.bio_en).toBe('Producer from Tallinn')
    expect(person.picture).toBe(strapi.state.uploads[0].id)
    const user = [...strapi.state.users.values()][0]
    expect(user.user_roles).toEqual([ROLE_CG])
    expect(stats.editions.attached).toBe(2)
    expect(stats.build.ids).toEqual([person.id])
  })

  it('prefers the MyPoff-linked Strapi user and its existing person over an email lookup', async () => {
    strapi.state.users.set(500, { id: 500, email: 'old@example.com', person: 42, user_roles: [] })
    strapi.state.people.set(42, { id: 42, firstName: 'Old', lastName: 'Name', eMail: 'old@example.com', festival_editions: [CG], user: 500 })
    fiona.state.guestbooks.set(GB, guestbookWith(accreditation('acc3', 'fp3', BADGE_TEAM, 'approved')))
    fiona.state.persons.set('fp3', { firstName: 'New', lastName: 'Name', email: 'new@example.com', myPoffUserId: '500' })

    const stats = await runSync({}, deps)

    expect(strapi.state.people.size).toBe(1)
    const person = strapi.state.people.get(42)
    expect(person.firstName).toBe('New')
    expect(person.fiona_person_id).toBe('fp3')
    expect(person.festival_editions).toEqual([CG])
    expect(strapi.state.users.size).toBe(1)
    expect(stats.persons.updated).toBe(1)
    expect(stats.users.created).toBe(0)
  })

  it('finds an already synced person by fiona_person_id even when the email changed', async () => {
    strapi.state.people.set(43, { id: 43, firstName: 'X', lastName: 'Y', eMail: 'first@example.com', fiona_person_id: 'fp4', fiona_guestbook_ids: GB, festival_editions: [], user: 501 })
    strapi.state.users.set(501, { id: 501, email: 'first@example.com', person: 43, user_roles: [] })
    fiona.state.guestbooks.set(GB, guestbookWith(accreditation('acc4', 'fp4', BADGE_TEAM, 'approved')))
    fiona.state.persons.set('fp4', { firstName: 'X', lastName: 'Y', email: 'second@example.com' })

    await runSync({}, deps)

    expect(strapi.state.people.size).toBe(1)
    expect(strapi.state.people.get(43).eMail).toBe('second@example.com')
  })

  it('skips a person with no email at all', async () => {
    fiona.state.guestbooks.set(GB, guestbookWith(accreditation('acc5', 'fp5', BADGE_TEAM, 'approved')))
    fiona.state.persons.set('fp5', { firstName: 'No', lastName: 'Mail' })

    const stats = await runSync({}, deps)

    expect(strapi.state.people.size).toBe(0)
    expect(stats.persons.skippedNoEmail).toBe(1)
  })

  it('does not write person email or phone when Fiona says contact details may not be published', async () => {
    fiona.state.guestbooks.set(GB, guestbookWith(accreditation('acc6', 'fp6', BADGE_TEAM, 'approved', { noPublicationOfContactDetails: true })))
    fiona.state.persons.set('fp6', { firstName: 'P', lastName: 'Q', email: 'pq@example.com', phone: '123' })

    await runSync({}, deps)

    const person = [...strapi.state.people.values()][0]
    expect(person.eMail).toBeUndefined()
    expect(person.phoneNr).toBeUndefined()
    const user = [...strapi.state.users.values()][0]
    expect(user.email).toBe('pq@example.com')
    expect(strapi.state.profiles.get(user.id).email).toBe('pq@example.com')
  })

  it('an immediate second run changes nothing', async () => {
    fiona.state.guestbooks.set(GB, guestbookWith(accreditation('acc2', 'fp2', BADGE_PRO, 'Paid')))
    fiona.state.persons.set('fp2', { firstName: 'Jaan', lastName: 'Tamm', email: 'jaan@example.com', bio: 'b', photo: 'x' })
    await runSync({}, deps)
    const writesAfterFirst = strapi.state.writes.length
    const uploadsAfterFirst = strapi.state.uploads.length

    const stats = await runSync({}, deps)

    expect(strapi.state.writes.length).toBe(writesAfterFirst)
    expect(strapi.state.uploads.length).toBe(uploadsAfterFirst)
    expect(stats.persons).toMatchObject({ desired: 1, created: 0, updated: 0, unchanged: 1 })
  })

  it('unpublishes a managed person whose badge no longer matches', async () => {
    fiona.state.guestbooks.set(GB, guestbookWith(accreditation('acc2', 'fp2', BADGE_PRO, 'Paid')))
    fiona.state.persons.set('fp2', { firstName: 'Jaan', lastName: 'Tamm', email: 'jaan@example.com' })
    await runSync({}, deps)
    fiona.state.guestbooks.get(GB).accreditations[0].badges[0].statusText = 'Cancelled'

    const stats = await runSync({}, deps)

    const person = [...strapi.state.people.values()][0]
    expect(person.festival_editions).toEqual([])
    expect(person.show_in_cg_search).toBe(false)
    expect(person.fiona_unpublished_at).toBe('2026-09-13T10:00:00.000Z')
    expect(person.fiona_attached_edition_ids).toBe('')
    expect(person.fiona_assigned_role_ids).toBe('')
    const user = [...strapi.state.users.values()][0]
    expect(user.user_roles).toEqual([])
    expect(stats.persons.unpublished).toBe(1)
    expect(stats.editions.detached).toBe(2)
  })

  it('re-sync after unpublish restores search visibility and the editions', async () => {
    fiona.state.guestbooks.set(GB, guestbookWith(accreditation('acc2', 'fp2', BADGE_PRO, 'Paid')))
    fiona.state.persons.set('fp2', { firstName: 'Jaan', lastName: 'Tamm', email: 'jaan@example.com' })
    await runSync({}, deps)
    fiona.state.guestbooks.get(GB).accreditations[0].badges[0].statusText = 'Cancelled'
    await runSync({}, deps)
    fiona.state.guestbooks.get(GB).accreditations[0].badges[0].statusText = 'Paid'

    await runSync({}, deps)

    const person = [...strapi.state.people.values()][0]
    expect(person.festival_editions.sort()).toEqual([CG, IND])
    expect(person.show_in_cg_search).toBe(true)
    expect(person.fiona_unpublished_at).toBeNull()
  })

  it('dropping from level 2 to level 1 detaches editions and roles but keeps the person', async () => {
    strapi.state.rules = [TEAM_RULE, rule({ ...PRO_RULE, sync_statuses: 'pending, approved, paid', full_profile_statuses: 'approved, paid' })]
    fiona.state.guestbooks.set(GB, guestbookWith(accreditation('acc2', 'fp2', BADGE_PRO, 'Paid')))
    fiona.state.persons.set('fp2', { firstName: 'Jaan', lastName: 'Tamm', email: 'jaan@example.com' })
    await runSync({}, deps)
    fiona.state.guestbooks.get(GB).accreditations[0].badges[0].statusText = 'Pending'

    const stats = await runSync({}, deps)

    const person = [...strapi.state.people.values()][0]
    expect(person.festival_editions).toEqual([])
    expect(person.show_in_cg_search).not.toBe(false)
    expect(person.fiona_unpublished_at).toBeFalsy()
    expect([...strapi.state.users.values()][0].user_roles).toEqual([])
    expect(stats.persons.downgraded).toBe(1)
    expect(stats.persons.unpublished).toBe(0)
  })

  it('leaves persons alone when their guestbook could not be fetched', async () => {
    fiona.state.guestbooks.set(GB, guestbookWith(accreditation('acc2', 'fp2', BADGE_PRO, 'Paid')))
    fiona.state.persons.set('fp2', { firstName: 'Jaan', lastName: 'Tamm', email: 'jaan@example.com' })
    await runSync({}, deps)
    const before = strapi.state.writes.length
    fiona.state.failGuestbooks.add(GB)

    const stats = await runSync({}, deps)

    expect(strapi.state.writes.length).toBe(before)
    expect(stats.guestbooks).toMatchObject({ active: 1, scanned: 0, failed: 1 })
    expect(stats.persons.unpublished).toBe(0)
  })

  it('records error messages in the stats so a dry run explains failures by itself', async () => {
    fiona.state.failGuestbooks.add(GB)

    const stats = await runSync({ dryRun: true }, deps)

    expect(stats.errors).toBe(1)
    expect(stats.errorMessages).toHaveLength(1)
    expect(stats.errorMessages[0]).toMatch(/guestbook guestbook-2025 .*fiona down for guestbook-2025/)
  })

  it('includes the HTTP status and response body of a failed Fiona call in the error message', async () => {
    fiona.listAccreditations = () => {
      const err = new Error('Unauthorized')
      err.statusCode = 401
      err.data = { message: 'Invalid api key' }
      throw err
    }
    fiona.state.guestbooks.set(GB, guestbookWith())

    const stats = await runSync({ dryRun: true }, deps)

    expect(stats.errorMessages[0]).toMatch(/HTTP 401/)
    expect(stats.errorMessages[0]).toMatch(/Invalid api key/)
  })

  it('lists the guestbooks Fiona knows when a configured guestbook cannot be fetched', async () => {
    fiona.state.failGuestbooks.add(GB)
    fiona.state.knownGuestbooks = [{ id: 'gb-real', name: 'Guestbook 2026' }]

    const stats = await runSync({ dryRun: true }, deps)

    expect(stats.knownGuestbooks).toEqual([{ id: 'gb-real', name: 'Guestbook 2026' }])
    expect(log.lines.warn.join('\n')).toMatch(/guestbook guestbook-2025 is NOT among the guestbooks Fiona knows/)
    expect(log.lines.warn.join('\n')).toMatch(/Guestbook 2026 \(gb-real\)/)
  })

  it('says so when the failed guestbook id is known to Fiona', async () => {
    fiona.state.failGuestbooks.add(GB)
    fiona.state.knownGuestbooks = [{ id: GB, name: 'Guestbook 2026' }]

    await runSync({ dryRun: true }, deps)

    expect(log.lines.warn.join('\n')).toMatch(/guestbook guestbook-2025 is known to Fiona as "Guestbook 2026" — the error is on Fiona's side/)
  })

  it('never removes when no active rule maps to a scanned guestbook', async () => {
    fiona.state.guestbooks.set(GB, guestbookWith(accreditation('acc2', 'fp2', BADGE_PRO, 'Paid')))
    fiona.state.persons.set('fp2', { firstName: 'Jaan', lastName: 'Tamm', email: 'jaan@example.com' })
    await runSync({}, deps)
    strapi.state.rules = [rule({ id: 9, badge_type_id: 'unknown-badge', badge_type_name: 'Nobody' })]

    const stats = await runSync({}, deps)

    expect(stats.persons.unpublished).toBe(0)
    expect(stats.rules).toMatchObject({ active: 1, mapped: 0, unmapped: 1 })
    expect(log.lines.warn.join('\n')).toMatch(/removal phase skipped/)
  })

  it('logs each scanned guestbook badge list with GUIDs so rules can be filled from real values', async () => {
    fiona.state.guestbooks.set(GB, guestbookWith())

    await runSync({ dryRun: true }, deps)

    expect(log.lines.info.join('\n')).toMatch(/Guestbook guestbook-2025 badges: TEAM \(badge-team-guid\), Industry PRO \(badge-pro-guid\)/)
  })

  it('with no rules, a dry run still discovers guestbook badges and status counts', async () => {
    strapi.state.rules = []
    fiona.state.guestbooks.set(GB, guestbookWith(accreditation('acc1', 'fp1', BADGE_PRO, 'Approved')))
    fiona.state.persons.set('fp1', { firstName: 'A', lastName: 'B', email: 'a@b.ee' })

    const stats = await runSync({ dryRun: true }, deps)

    expect(stats.guestbooks).toMatchObject({ active: 1, scanned: 1 })
    expect(stats.guestbookBadges[GB]).toEqual(['TEAM (badge-team-guid)', 'Industry PRO (badge-pro-guid)'])
    expect(stats.badgeStatuses).toEqual({ 'Industry PRO (badge-pro-guid)': { approved: 1 } })
    expect(stats.persons.desired).toBe(0)
    expect(strapi.state.writes).toEqual([])
  })

  it('with no rules, a real run stops before touching accreditations', async () => {
    strapi.state.rules = []
    fiona.state.guestbooks.set(GB, guestbookWith(accreditation('acc1', 'fp1', BADGE_PRO, 'Approved')))

    const stats = await runSync({}, deps)

    expect(stats.accreditations.seen).toBe(0)
    expect(stats.removals.skipped).toBe(true)
    expect(strapi.state.writes).toEqual([])
  })

  it('returns each scanned guestbook badge list in the stats', async () => {
    fiona.state.guestbooks.set(GB, guestbookWith())

    const stats = await runSync({ dryRun: true }, deps)

    expect(stats.guestbookBadges).toEqual({ [GB]: ['TEAM (badge-team-guid)', 'Industry PRO (badge-pro-guid)'] })
  })

  it('counts the badge statuses seen per badge and reports them in stats and the log', async () => {
    fiona.state.guestbooks.set(GB, guestbookWith(
      accreditation('acc1', 'fp1', BADGE_PRO, 'Approved'),
      accreditation('acc2', 'fp2', BADGE_PRO, 'approved'),
      accreditation('acc3', 'fp3', BADGE_PRO, 'Cancelled'),
      accreditation('acc4', 'fp4', BADGE_TEAM, 'Created')
    ))
    for (const id of ['fp1', 'fp2', 'fp3', 'fp4']) fiona.state.persons.set(id, { firstName: id, lastName: 'x', email: `${id}@x.ee` })

    const stats = await runSync({ dryRun: true }, deps)

    expect(stats.badgeStatuses).toEqual({
      'Industry PRO (badge-pro-guid)': { approved: 2, cancelled: 1 },
      'TEAM (badge-team-guid)': { created: 1 }
    })
    expect(log.lines.info.join('\n')).toMatch(/badge "Industry PRO" \(badge-pro-guid\) statuses: approved=2, cancelled=1/)
  })

  it('explains why no guestbook is active by listing editions with a guestbook id and their windows', async () => {
    strapi.state.activeGuestbookIds = []
    strapi.state.editionsWithGuestbook = [
      { id: 86, name: 'PÖFF 29', guestbookId: 'gb-29', validFrom: '2026-09-13T10:00:00.000Z', validUntil: '2026-12-31T00:00:00.000Z' },
      { id: 87, name: 'Industry 2025', guestbookId: 'gb-25', validFrom: null, validUntil: null },
      { id: 88, name: 'Old', guestbookId: 'gb-old', validFrom: '2025-01-01T00:00:00.000Z', validUntil: '2025-12-31T00:00:00.000Z' }
    ]

    const stats = await runSync({ dryRun: true }, deps)

    expect(stats.guestbooks.active).toBe(0)
    expect(stats.editionsWithGuestbook).toEqual([
      { id: 86, name: 'PÖFF 29', guestbookId: 'gb-29', validFrom: '2026-09-13T10:00:00.000Z', validUntil: '2026-12-31T00:00:00.000Z', active: false, reason: 'validFrom is not before today (2026-09-13)' },
      { id: 87, name: 'Industry 2025', guestbookId: 'gb-25', validFrom: null, validUntil: null, active: false, reason: 'validFrom and validUntil are not set' },
      { id: 88, name: 'Old', guestbookId: 'gb-old', validFrom: '2025-01-01T00:00:00.000Z', validUntil: '2025-12-31T00:00:00.000Z', active: false, reason: 'validUntil is not after today (2026-09-13)' }
    ])
    expect(log.lines.warn.join('\n')).toMatch(/edition #86 "PÖFF 29" guestbook gb-29 .*validFrom is not before today/)
  })

  it('warns when no edition has a guestbook id at all', async () => {
    strapi.state.activeGuestbookIds = []

    await runSync({ dryRun: true }, deps)

    expect(log.lines.warn.join('\n')).toMatch(/no festival edition has a guestbook_id/)
  })

  it('dry run writes nothing and reports what it would do', async () => {
    fiona.state.guestbooks.set(GB, guestbookWith(accreditation('acc2', 'fp2', BADGE_PRO, 'Paid')))
    fiona.state.persons.set('fp2', { firstName: 'Jaan', lastName: 'Tamm', email: 'jaan@example.com' })

    const stats = await runSync({ dryRun: true }, deps)

    expect(strapi.state.writes).toEqual([])
    expect(strapi.state.people.size).toBe(0)
    expect(strapi.state.users.size).toBe(0)
    expect(stats.dryRun).toBe(true)
    expect(stats.persons.created).toBe(1)
    expect(log.lines.info.join('\n')).toMatch(/would CREATE person fp2/)
    expect(stats.dryRunActions).toEqual([
      { action: 'CREATE', fionaPersonId: 'fp2', name: 'Jaan Tamm', level: 2, editionIds: [CG, IND], roleIds: [ROLE_CG], changed: null }
    ])
  })

  it('dry run lists downgrade and unpublish actions too', async () => {
    fiona.state.guestbooks.set(GB, guestbookWith(accreditation('acc2', 'fp2', BADGE_PRO, 'Paid')))
    fiona.state.persons.set('fp2', { firstName: 'Jaan', lastName: 'Tamm', email: 'jaan@example.com' })
    await runSync({}, deps)
    fiona.state.guestbooks.get(GB).accreditations[0].badges[0].statusText = 'Cancelled'

    const stats = await runSync({ dryRun: true }, deps)

    expect(stats.dryRunActions).toEqual([{ action: 'UNPUBLISH', fionaPersonId: 'fp2', personId: 1000, detachEditionIds: [CG, IND], removeRoleIds: [ROLE_CG] }])
  })

  it('logs a build instruction instead of triggering builds above the per-run cap', async () => {
    deps.config.maxBuildsPerRun = 1
    fiona.state.guestbooks.set(GB, guestbookWith(
      accreditation('acc2', 'fp2', BADGE_PRO, 'Paid'),
      accreditation('acc7', 'fp7', BADGE_PRO, 'Paid')
    ))
    fiona.state.persons.set('fp2', { firstName: 'A', lastName: 'A', email: 'a@a.ee' })
    fiona.state.persons.set('fp7', { firstName: 'B', lastName: 'B', email: 'b@b.ee' })

    const stats = await runSync({}, deps)

    expect(stats.build.triggered).toBe(false)
    expect(stats.build.ids).toHaveLength(2)
    const touches = strapi.state.writes.filter(w => w.op === 'updatePerson' && w.payload.skipbuild !== true)
    expect(touches).toHaveLength(0)
    expect(log.lines.warn.join('\n')).toMatch(/full build/i)
  })

  it('triggers one build touch per changed level-2 person within the cap', async () => {
    fiona.state.guestbooks.set(GB, guestbookWith(accreditation('acc2', 'fp2', BADGE_PRO, 'Paid')))
    fiona.state.persons.set('fp2', { firstName: 'A', lastName: 'A', email: 'a@a.ee' })

    const stats = await runSync({}, deps)

    expect(stats.build.triggered).toBe(true)
    const touches = strapi.state.writes.filter(w => w.op === 'updatePerson' && w.payload.skipbuild !== true)
    expect(touches).toHaveLength(1)
  })

  describe('run modes and job state', () => {
    const job = (overrides = {}) => ({
      id: 1,
      key: 'accreditations',
      enabled: true,
      incremental_interval_minutes: 15,
      full_run_hour: 3,
      mutation_cursor: '2026-09-13T09:00:00.000Z',
      last_incremental_run_at: '2026-09-13T09:00:00.000Z',
      last_full_run_at: '2026-09-12T03:00:00.000Z',
      last_stats: null,
      last_error: null,
      ...overrides
    })
    const seedTwoLevel2People = () => {
      fiona.state.guestbooks.set(GB, guestbookWith(
        accreditation('acc2', 'fp2', BADGE_PRO, 'Paid', { badges: [{ id: 'bad2', badgeId: BADGE_PRO, badgeName: '', statusText: 'Paid' }] }),
        accreditation('acc7', 'fp7', BADGE_PRO, 'Paid', { badges: [{ id: 'bad7', badgeId: BADGE_PRO, badgeName: '', statusText: 'Paid' }] })
      ))
      fiona.state.persons.set('fp2', { firstName: 'A', lastName: 'A', email: 'a@a.ee' })
      fiona.state.persons.set('fp7', { firstName: 'B', lastName: 'B', email: 'b@b.ee' })
    }

    it('a full run records the cursor, the full-run time and the stats on the job', async () => {
      strapi.state.syncJob = job({ mutation_cursor: null, last_full_run_at: null })
      seedTwoLevel2People()

      const stats = await runSync({ mode: 'full' }, deps)

      expect(stats.mode).toBe('full')
      expect(strapi.state.syncJob.mutation_cursor).toBe('2026-09-13T10:00:00.000Z')
      expect(strapi.state.syncJob.last_full_run_at).toBe('2026-09-13T10:00:00.000Z')
      expect(strapi.state.syncJob.last_stats.persons.created).toBe(2)
      expect(strapi.state.syncJob.last_error).toBeNull()
    })

    it('a dry run never touches the job', async () => {
      strapi.state.syncJob = job()
      seedTwoLevel2People()

      await runSync({ mode: 'full', dryRun: true }, deps)

      expect(strapi.state.writes.filter(w => w.op === 'saveSyncJob')).toEqual([])
    })

    it('an incremental run re-evaluates only the mutated accreditations and leaves the others alone', async () => {
      strapi.state.syncJob = job({ mutation_cursor: null })
      seedTwoLevel2People()
      await runSync({ mode: 'full' }, deps)
      strapi.state.syncJob = job({ mutation_cursor: '2026-09-13T09:50:00.000Z' })
      // both people lose their badge status in Fiona, but only acc2 is reported as mutated
      for (const a of fiona.state.guestbooks.get(GB).accreditations) a.badges[0].statusText = 'Cancelled'
      fiona.state.mutations = [{ entityName: 'Accreditation', entityId: 'acc2', mutation: 1 }]

      const stats = await runSync({ mode: 'incremental' }, deps)

      const people = [...strapi.state.people.values()]
      const p2 = people.find(p => p.fiona_person_id === 'fp2')
      const p7 = people.find(p => p.fiona_person_id === 'fp7')
      expect(p2.show_in_cg_search).toBe(false)
      expect(p2.festival_editions).toEqual([])
      expect(p7.show_in_cg_search).not.toBe(false)
      expect(p7.festival_editions.sort()).toEqual([CG, IND])
      expect(stats.mode).toBe('incremental')
      expect(stats.incremental).toMatchObject({ mutations: 1, accreditations: 1, persons: 1 })
      expect(fiona.state.lastMutationsSince).toBe('2026-09-13T09:45:00.000Z') // cursor minus 5 min overlap
      expect(strapi.state.syncJob.mutation_cursor).toBe('2026-09-13T10:00:00.000Z')
      expect(strapi.state.syncJob.last_incremental_run_at).toBe('2026-09-13T10:00:00.000Z')
    })

    it('an incremental run picks up a new accreditation badge and creates the person', async () => {
      strapi.state.syncJob = job()
      seedTwoLevel2People()
      fiona.state.mutations = [{ entityName: 'AccreditationBadge', entityId: 'bad7', mutation: 0 }]

      const stats = await runSync({ mode: 'incremental' }, deps)

      expect([...strapi.state.people.values()].map(p => p.fiona_person_id)).toEqual(['fp7'])
      expect(stats.persons.created).toBe(1)
    })

    it('an incremental run unpublishes a managed person whose Fiona person was deleted', async () => {
      strapi.state.syncJob = job({ mutation_cursor: null })
      seedTwoLevel2People()
      await runSync({ mode: 'full' }, deps)
      strapi.state.syncJob = job()
      fiona.state.guestbooks.get(GB).accreditations = fiona.state.guestbooks.get(GB).accreditations.filter(a => a.personId !== 'fp2')
      fiona.state.persons.delete('fp2')
      fiona.state.mutations = [{ entityName: 'Person', entityId: 'fp2', mutation: 2 }]

      const stats = await runSync({ mode: 'incremental' }, deps)

      const p2 = [...strapi.state.people.values()].find(p => p.fiona_person_id === 'fp2')
      expect(p2.show_in_cg_search).toBe(false)
      expect(stats.persons.unpublished).toBe(1)
    })

    it('an incremental run without a cursor falls back to a full run', async () => {
      strapi.state.syncJob = job({ mutation_cursor: null })
      seedTwoLevel2People()

      const stats = await runSync({ mode: 'incremental' }, deps)

      expect(stats.mode).toBe('full')
      expect(stats.persons.created).toBe(2)
      expect(log.lines.warn.join('\n')).toMatch(/no mutation cursor yet/)
    })

    it('an incremental run ignores mutations of other entity types', async () => {
      strapi.state.syncJob = job()
      seedTwoLevel2People()
      fiona.state.mutations = [{ entityName: 'Film', entityId: 'f1', mutation: 1 }, { entityName: 'Lookup', entityId: 'l1', mutation: 1 }]

      const stats = await runSync({ mode: 'incremental' }, deps)

      expect(stats.incremental).toMatchObject({ mutations: 2, relevant: 0, accreditations: 0, persons: 0 })
      expect(strapi.state.people.size).toBe(0)
    })

    it('auto mode: skips when the job is disabled', async () => {
      strapi.state.syncJob = job({ enabled: false })
      seedTwoLevel2People()

      const stats = await runSync({ mode: 'auto' }, deps)

      expect(stats.skipped).toBe(true)
      expect(stats.reason).toMatch(/disabled/)
      expect(strapi.state.people.size).toBe(0)
    })

    it('auto mode: skips when the interval has not passed', async () => {
      strapi.state.syncJob = job({ last_incremental_run_at: '2026-09-13T09:50:00.000Z', incremental_interval_minutes: 15, last_full_run_at: '2026-09-13T03:00:00.000Z' })

      const stats = await runSync({ mode: 'auto' }, deps)

      expect(stats.skipped).toBe(true)
      expect(stats.reason).toMatch(/not due/)
    })

    it('auto mode: runs incrementally when the interval has passed', async () => {
      strapi.state.syncJob = job({ last_incremental_run_at: '2026-09-13T09:40:00.000Z', incremental_interval_minutes: 15, last_full_run_at: '2026-09-13T03:00:00.000Z' })
      seedTwoLevel2People()

      const stats = await runSync({ mode: 'auto' }, deps)

      expect(stats.mode).toBe('incremental')
    })

    it('auto mode: runs a full run once a day after the configured hour', async () => {
      strapi.state.syncJob = job({ last_incremental_run_at: '2026-09-13T09:55:00.000Z', last_full_run_at: '2026-09-12T03:00:00.000Z', full_run_hour: 3 })
      seedTwoLevel2People()

      const stats = await runSync({ mode: 'auto' }, deps)

      expect(stats.mode).toBe('full')
      expect(strapi.state.syncJob.last_full_run_at).toBe('2026-09-13T10:00:00.000Z')
    })

    it('auto mode: skips with a warning when no job entry exists', async () => {
      strapi.state.syncJob = null

      const stats = await runSync({ mode: 'auto' }, deps)

      expect(stats.skipped).toBe(true)
      expect(log.lines.warn.join('\n')).toMatch(/no fiona-sync-job entry with key "accreditations"/)
    })

    it('records the first error message on the job', async () => {
      strapi.state.syncJob = job({ mutation_cursor: null })
      fiona.state.failGuestbooks.add(GB)

      await runSync({ mode: 'full' }, deps)

      expect(strapi.state.syncJob.last_error).toMatch(/fiona down/)
    })
  })
})
