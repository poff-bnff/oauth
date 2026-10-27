import { describe, it, expect, beforeEach } from 'vitest'
import { runSync, decideAutoMode } from '../server/utils/fiona/sync.js'

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
    photoCalls: [],
    personCalls: [],
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
      return {
        personId: a.personId,
        guestbookId: a.guestbookId,
        noPublicationOfContactDetails: !!a.noPublicationOfContactDetails,
        noPublicationOfEmail: !!a.noPublicationOfEmail,
        noPublicationOfPhone: !!a.noPublicationOfPhone,
        customFields: a.customFields || [],
        films: []
      }
    },
    getPerson (personId, options) {
      state.personCalls.push({ personId, ...options })
      if (state.failPersons.has(personId)) throw new Error(`person ${personId} unavailable`)
      const p = state.persons.get(personId)
      if (!p) throw new Error(`no person ${personId}`)
      return { firstName: p.firstName, lastName: p.lastName, email: p.email, phone: p.phone || null, bio: p.bio || null, bioSource: p.bioSource }
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
    getPersonPhoto (personId, options) {
      state.photoCalls.push({ personId, ...options })
      const p = state.persons.get(personId)
      return p?.photo ? { buffer: Buffer.from(p.photo), filename: `fiona-person-${personId}.jpg`, source: p.photoSource, choice: p.photoChoice } : null
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
    orphanUploads: [], // files already in the media library that no person uses: { id, filename, size }
    writes: [],
    emails: [], // Creative Gate "created" emails Strapi's hooks would send: { userId, personId }
    publisherRoleIds: new Set([ROLE_CG]), // roles with publish_cg_person
    nextId: 1000
  }
  const nextId = () => state.nextId++
  const clone = v => JSON.parse(JSON.stringify(v))
  const populated = p => ({ ...clone(p), festival_editions: (p.festival_editions || []).map(id => ({ id })) })
  // Strapi's Creative Gate hooks (web2021 creative_gate_email_notification.js): a person is "ready" when it holds the
  // CG edition and a linked user (Strapi fills the slugs itself). The "created" email goes out on the save that makes
  // it ready, and only if the user holds a publisher role AT THAT MOMENT.
  const readyUserId = person => ((person?.festival_editions || []).map(Number).includes(CG) && person?.user ? Number(person.user) : null)
  const notifyWhenReady = (person, before = null) => {
    const userId = readyUserId(person)
    if (!userId || userId === readyUserId(before)) return
    const user = state.users.get(userId)
    if (!(user.user_roles || []).some(roleId => state.publisherRoleIds.has(Number(roleId)))) return
    state.emails.push({ userId, personId: person.id })
  }
  return {
    state,
    loadRules () { return clone(state.rules) },
    getActiveGuestbookIds () { return [...state.activeGuestbookIds] },
    listEditionsWithGuestbook () { return clone(state.editionsWithGuestbook) },
    getSyncJob (key) { return state.syncJob && state.syncJob.key === key ? clone(state.syncJob) : null },
    getSyncJobs (key) {
      if (!state.extraJobs) return state.syncJob && state.syncJob.key === key ? [clone(state.syncJob)] : []
      return [state.syncJob, ...state.extraJobs].filter(j => j && j.key === key).map(clone)
    },
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
      notifyWhenReady(p)
      return populated(p)
    },
    updatePerson (id, payload) {
      const p = state.people.get(Number(id))
      const before = clone(p)
      Object.assign(p, clone(payload))
      state.writes.push({ op: 'updatePerson', id: Number(id), payload: clone(payload) })
      if (['festival_editions', 'firstName', 'lastName', 'user'].some(field => payload[field] !== undefined)) notifyWhenReady(p, before)
      return populated(p)
    },
    linkPersonToUser (personId, userId) {
      const user = state.users.get(Number(userId))
      const previousPerson = user.person
      user.person = Number(personId)
      state.people.get(Number(personId)).user = Number(userId)
      state.writes.push({ op: 'linkPersonToUser', id: Number(userId), payload: { person: Number(personId) } })
      if (Number(previousPerson) !== Number(personId)) notifyWhenReady(state.people.get(Number(personId)))
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
    uploadPhoto (buffer, filename, options = {}) {
      const id = options.replaceId ?? nextId()
      state.uploads.push({ id, filename, size: buffer.length, replaced: Boolean(options.replaceId) })
      return id
    },
    findOrphanPhoto (filename) {
      const hit = state.orphanUploads.find(file => file.filename === filename)
      return hit ? hit.id : null
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
    expect(stats.build.ids).toEqual([]) // builds stay off unless the rule switches them on
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

  it('"Do not publish email info" keeps the email off the person but still creates the user and profile with it', async () => {
    fiona.state.guestbooks.set(GB, guestbookWith(accreditation('acc7', 'fp7', BADGE_TEAM, 'approved', { noPublicationOfEmail: true })))
    fiona.state.persons.set('fp7', { firstName: 'E', lastName: 'Flag', email: 'e@example.com', phone: '555' })

    const stats = await runSync({}, deps)

    const person = [...strapi.state.people.values()][0]
    expect(person.eMail).toBeUndefined()
    expect(person.phoneNr).toBe('555')
    const user = [...strapi.state.users.values()][0]
    expect(user.email).toBe('e@example.com')
    expect(strapi.state.profiles.get(user.id).email).toBe('e@example.com')
    expect(stats.privacy).toEqual({ emailWithheld: 1, phoneWithheld: 0, emailCleared: 0, phoneCleared: 0 })
  })

  it('"Do not publish phone info" keeps the phone off the person but writes the email', async () => {
    fiona.state.guestbooks.set(GB, guestbookWith(accreditation('acc8', 'fp8', BADGE_TEAM, 'approved', { noPublicationOfPhone: true })))
    fiona.state.persons.set('fp8', { firstName: 'P', lastName: 'Flag', email: 'p@example.com', phone: '777' })

    const stats = await runSync({}, deps)

    const person = [...strapi.state.people.values()][0]
    expect(person.eMail).toBe('p@example.com')
    expect(person.phoneNr).toBeUndefined()
    expect(stats.privacy).toEqual({ emailWithheld: 0, phoneWithheld: 1, emailCleared: 0, phoneCleared: 0 })
  })

  it('"Do not publish contact details" counts as both flags', async () => {
    fiona.state.guestbooks.set(GB, guestbookWith(accreditation('acc9', 'fp9', BADGE_TEAM, 'approved', { noPublicationOfContactDetails: true })))
    fiona.state.persons.set('fp9', { firstName: 'C', lastName: 'Flag', email: 'c@example.com', phone: '999' })

    const stats = await runSync({}, deps)

    expect(stats.privacy).toEqual({ emailWithheld: 1, phoneWithheld: 1, emailCleared: 0, phoneCleared: 0 })
  })

  it('a flag on any of a person\'s accreditations withholds the value', async () => {
    fiona.state.guestbooks.set(GB, guestbookWith(
      accreditation('acc10', 'fp10', BADGE_TEAM, 'approved'),
      accreditation('acc11', 'fp10', BADGE_TEAM, 'approved', { noPublicationOfEmail: true })
    ))
    fiona.state.persons.set('fp10', { firstName: 'T', lastName: 'Two', email: 't@example.com', phone: '1' })

    await runSync({}, deps)

    expect([...strapi.state.people.values()][0].eMail).toBeUndefined()
  })

  it('reports which custom field keys the matched accreditations carry, so a wrong key name is visible', async () => {
    fiona.state.guestbooks.set(GB, guestbookWith(
      accreditation('acc12', 'fp12', BADGE_TEAM, 'approved', { customFields: [{ key: 'do-not-publish-email-info', value: true }, { key: 'delivered-by', value: '2026-10-28' }] }),
      accreditation('acc13', 'fp13', BADGE_TEAM, 'approved', { customFields: [{ key: 'do-not-publish-email-info', value: false }] })
    ))
    fiona.state.persons.set('fp12', { firstName: 'A', lastName: 'A', email: 'a12@example.com' })
    fiona.state.persons.set('fp13', { firstName: 'B', lastName: 'B', email: 'b13@example.com' })

    const stats = await runSync({ dryRun: true }, deps)

    expect(stats.customFieldKeys).toEqual({
      'do-not-publish-email-info': { accreditations: 2, ticked: 1 },
      'delivered-by': { accreditations: 1, ticked: 0 }
    })
  })

  it('names the withheld values on the dry-run action', async () => {
    fiona.state.guestbooks.set(GB, guestbookWith(accreditation('acc14', 'fp14', BADGE_TEAM, 'approved', { noPublicationOfEmail: true })))
    fiona.state.persons.set('fp14', { firstName: 'D', lastName: 'Run', email: 'd@example.com', phone: '1' })

    const stats = await runSync({ dryRun: true }, deps)

    expect(stats.dryRunActions[0]).toMatchObject({ action: 'CREATE', fionaPersonId: 'fp14', withheld: ['email'] })
  })

  it('dry run shows, for an existing person, the Strapi and the Fiona value of every content field that would change', async () => {
    strapi.state.users.set(500, { id: 500, email: 'old@example.com', person: 42, user_roles: [] })
    strapi.state.people.set(42, {
      id: 42,
      firstName: 'Old',
      lastName: 'Name',
      firstNameLastName: 'Old Name',
      eMail: 'old@example.com',
      phoneNr: '111',
      bio_en: 'Own bio',
      updated_at: '2026-05-01T08:00:00.000Z',
      festival_editions: [],
      user: 500
    })
    fiona.state.guestbooks.set(GB, guestbookWith(accreditation('acc3', 'fp3', BADGE_PRO, 'approved')))
    fiona.state.persons.set('fp3', { firstName: 'New', lastName: 'Name', email: 'new@example.com', phone: '222', bio: 'Fiona bio', myPoffUserId: '500' })

    const stats = await runSync({ dryRun: true }, deps)

    const action = stats.dryRunActions.find(a => a.personId === 42)
    expect(action.strapiUpdatedAt).toBe('2026-05-01T08:00:00.000Z')
    expect(action.diff).toEqual({
      firstName: { strapi: 'Old', fiona: 'New' },
      firstNameLastName: { strapi: 'Old Name', fiona: 'New Name' },
      eMail: { strapi: 'old@example.com', fiona: 'new@example.com' },
      phoneNr: { strapi: '111', fiona: '222' },
      bio_en: { strapi: 'Own bio', fiona: 'Fiona bio' }
    })
  })

  it('clips long values in the dry-run comparison', async () => {
    strapi.state.users.set(500, { id: 500, email: 'old@example.com', person: 42, user_roles: [] })
    strapi.state.people.set(42, { id: 42, firstName: 'A', lastName: 'B', firstNameLastName: 'A B', eMail: 'old@example.com', bio_en: 'x'.repeat(1000), festival_editions: [], user: 500 })
    fiona.state.guestbooks.set(GB, guestbookWith(accreditation('acc3', 'fp3', BADGE_PRO, 'approved')))
    fiona.state.persons.set('fp3', { firstName: 'A', lastName: 'B', email: 'old@example.com', bio: 'y'.repeat(1000), myPoffUserId: '500' })

    const stats = await runSync({ dryRun: true }, deps)

    const { bio_en: bio } = stats.dryRunActions.find(a => a.personId === 42).diff
    expect(bio.strapi).toBe(`${'x'.repeat(300)}…`)
    expect(bio.fiona).toBe(`${'y'.repeat(300)}…`)
  })

  it('has no comparison for a new person or when only relations change', async () => {
    strapi.state.users.set(500, { id: 500, email: 'a@example.com', person: 42, user_roles: [] })
    strapi.state.people.set(42, { id: 42, firstName: 'A', lastName: 'B', firstNameLastName: 'A B', eMail: 'a@example.com', festival_editions: [], user: 500 })
    fiona.state.guestbooks.set(GB, guestbookWith(
      accreditation('acc3', 'fp3', BADGE_TEAM, 'approved'),
      accreditation('acc4', 'fp4', BADGE_TEAM, 'approved')
    ))
    fiona.state.persons.set('fp3', { firstName: 'A', lastName: 'B', email: 'a@example.com', myPoffUserId: '500' })
    fiona.state.persons.set('fp4', { firstName: 'N', lastName: 'New', email: 'n@example.com' })

    const stats = await runSync({ dryRun: true }, deps)

    for (const action of stats.dryRunActions) {
      expect(action.diff).toBeUndefined()
      expect(action.strapiUpdatedAt).toBeUndefined()
    }
  })

  describe('a box ticked after the value was already written', () => {
    const seed = (personOverrides = {}) => {
      strapi.state.users.set(600, { id: 600, email: 'old@example.com', person: 60, user_roles: [] })
      strapi.state.people.set(60, {
        id: 60,
        firstName: 'Mari',
        lastName: 'Tamm',
        firstNameLastName: 'Mari Tamm',
        eMail: 'mari@example.com',
        phoneNr: '+372 555 1234',
        fiona_person_id: 'fp60',
        festival_editions: [],
        user: 600,
        ...personOverrides
      })
      fiona.state.persons.set('fp60', { firstName: 'Mari', lastName: 'Tamm', email: 'mari@example.com', phone: '+3725551234', myPoffUserId: '600' })
    }

    it('clears the phone the sync wrote earlier, comparing digits only', async () => {
      seed()
      fiona.state.guestbooks.set(GB, guestbookWith(accreditation('acc60', 'fp60', BADGE_TEAM, 'approved', { noPublicationOfPhone: true })))

      const stats = await runSync({}, deps)

      const person = strapi.state.people.get(60)
      expect(person.phoneNr).toBeNull()
      expect(person.eMail).toBe('mari@example.com')
      expect(stats.privacy).toEqual({ emailWithheld: 0, phoneWithheld: 1, emailCleared: 0, phoneCleared: 1 })
    })

    it('clears the email the sync wrote earlier, comparing case-insensitively', async () => {
      seed({ eMail: 'Mari@EXAMPLE.com' })
      fiona.state.guestbooks.set(GB, guestbookWith(accreditation('acc60', 'fp60', BADGE_TEAM, 'approved', { noPublicationOfEmail: true })))

      const stats = await runSync({}, deps)

      const person = strapi.state.people.get(60)
      expect(person.eMail).toBeNull()
      expect(person.phoneNr).toBe('+3725551234') // not withheld: Fiona's value, in Fiona's format, wins
      expect(stats.privacy.emailCleared).toBe(1)
    })

    it('leaves a value that differs from the one in Fiona, because someone typed it themselves', async () => {
      seed({ eMail: 'own@elsewhere.ee', phoneNr: '+372 999 0000' })
      fiona.state.guestbooks.set(GB, guestbookWith(accreditation('acc60', 'fp60', BADGE_TEAM, 'approved', { noPublicationOfContactDetails: true })))

      const stats = await runSync({}, deps)

      const person = strapi.state.people.get(60)
      expect(person.eMail).toBe('own@elsewhere.ee')
      expect(person.phoneNr).toBe('+372 999 0000')
      expect(stats.privacy.emailCleared).toBe(0)
      expect(stats.privacy.phoneCleared).toBe(0)
    })

    it('a dry run names the values it would clear and writes nothing', async () => {
      seed()
      fiona.state.guestbooks.set(GB, guestbookWith(accreditation('acc60', 'fp60', BADGE_TEAM, 'approved', { noPublicationOfContactDetails: true })))

      const stats = await runSync({ dryRun: true }, deps)

      const action = stats.dryRunActions.find(a => a.personId === 60)
      expect(action.cleared).toEqual(['email', 'phone'])
      expect(strapi.state.people.get(60).phoneNr).toBe('+372 555 1234')
    })

    it('a second run has nothing left to clear', async () => {
      seed()
      fiona.state.guestbooks.set(GB, guestbookWith(accreditation('acc60', 'fp60', BADGE_TEAM, 'approved', { noPublicationOfPhone: true })))
      await runSync({}, deps)
      const writes = strapi.state.writes.length

      const stats = await runSync({}, deps)

      expect(strapi.state.writes.length).toBe(writes)
      expect(stats.privacy.phoneCleared).toBe(0)
    })
  })

  describe('persons whose biography the sync must keep', () => {
    const seed = (bio) => {
      strapi.state.users.set(700, { id: 700, email: 'esko@example.com', person: 42, user_roles: [] })
      strapi.state.people.set(42, {
        id: 42, firstName: 'Esko', lastName: 'Old', firstNameLastName: 'Esko Old', eMail: 'esko@example.com', bio_en: bio, festival_editions: [], user: 700
      })
      fiona.state.guestbooks.set(GB, guestbookWith(accreditation('acc70', 'fp70', BADGE_PRO, 'approved')))
      fiona.state.persons.set('fp70', { firstName: 'Esko', lastName: 'Rips', email: 'esko@example.com', bio: 'Fiona bio', myPoffUserId: '700' })
    }

    it('keeps the existing biography of a listed person but still updates everything else', async () => {
      seed('Own bio')
      deps.config.keepBioPersonIds = '7, 42'

      await runSync({}, deps)

      const person = strapi.state.people.get(42)
      expect(person.bio_en).toBe('Own bio')
      expect(person.lastName).toBe('Rips')
      expect(person.fiona_person_id).toBe('fp70')
    })

    it('fills the biography of a listed person when it is empty', async () => {
      seed('')
      deps.config.keepBioPersonIds = '42'

      await runSync({}, deps)

      expect(strapi.state.people.get(42).bio_en).toBe('Fiona bio')
    })

    it('overwrites the biography of a person who is not listed', async () => {
      seed('Own bio')
      deps.config.keepBioPersonIds = '7, 99'

      await runSync({}, deps)

      expect(strapi.state.people.get(42).bio_en).toBe('Fiona bio')
    })

    it('overwrites by default when no person is listed', async () => {
      seed('Own bio')

      await runSync({}, deps)

      expect(strapi.state.people.get(42).bio_en).toBe('Fiona bio')
    })

    it('does not show the kept biography as a change in the dry run', async () => {
      seed('Own bio')
      deps.config.keepBioPersonIds = '42'

      const stats = await runSync({ dryRun: true }, deps)

      const action = stats.dryRunActions.find(a => a.personId === 42)
      expect(action.changed).not.toContain('bio_en')
      expect(action.diff).not.toHaveProperty('bio_en')
    })
  })

  describe('Creative Gate "created" email from Strapi', () => {
    it('a new full-profile person: the user is notified once, because the publisher role is in place before the person becomes ready', async () => {
      fiona.state.guestbooks.set(GB, guestbookWith(accreditation('acc80', 'fp80', BADGE_PRO, 'approved')))
      fiona.state.persons.set('fp80', { firstName: 'Mari', lastName: 'Maasikas', email: 'mari@example.com' })

      await runSync({}, deps)

      const user = [...strapi.state.users.values()][0]
      const person = [...strapi.state.people.values()][0]
      expect(strapi.state.emails).toEqual([{ userId: user.id, personId: person.id }])
    })

    it('an existing person already linked to its user: attaching the CG edition notifies the user once', async () => {
      strapi.state.users.set(800, { id: 800, email: 'old@example.com', person: 80, user_roles: [] })
      strapi.state.people.set(80, { id: 80, firstName: 'Old', lastName: 'Name', eMail: 'old@example.com', festival_editions: [IND], user: 800 })
      fiona.state.guestbooks.set(GB, guestbookWith(accreditation('acc81', 'fp81', BADGE_PRO, 'approved')))
      fiona.state.persons.set('fp81', { firstName: 'Old', lastName: 'Name', email: 'old@example.com', myPoffUserId: '800' })

      await runSync({}, deps)

      expect(strapi.state.emails).toEqual([{ userId: 800, personId: 80 }])
    })

    it('a person that already held the CG edition and a user is not notified again', async () => {
      strapi.state.users.set(801, { id: 801, email: 'own@example.com', person: 81, user_roles: [] })
      strapi.state.people.set(81, { id: 81, firstName: 'Own', lastName: 'Profile', eMail: 'own@example.com', festival_editions: [CG], user: 801 })
      fiona.state.guestbooks.set(GB, guestbookWith(accreditation('acc82', 'fp82', BADGE_PRO, 'approved')))
      fiona.state.persons.set('fp82', { firstName: 'Own', lastName: 'Profile', email: 'own@example.com', myPoffUserId: '801' })

      await runSync({}, deps)

      expect(strapi.state.emails).toEqual([])
    })

    it('a basic (level 1) person has no CG edition and gets no email', async () => {
      fiona.state.guestbooks.set(GB, guestbookWith(accreditation('acc83', 'fp83', BADGE_TEAM, 'approved')))
      fiona.state.persons.set('fp83', { firstName: 'Team', lastName: 'Member', email: 'team@example.com' })

      await runSync({}, deps)

      expect(strapi.state.emails).toEqual([])
    })

    it('no email when the rule grants no publisher role', async () => {
      strapi.state.rules = [rule({ id: 9, name: 'edition only', badge_type_id: BADGE_PRO, sync_statuses: 'approved', full_profile_statuses: 'approved', festival_editions: [{ id: CG }], user_roles: [] })]
      fiona.state.guestbooks.set(GB, guestbookWith(accreditation('acc84', 'fp84', BADGE_PRO, 'approved')))
      fiona.state.persons.set('fp84', { firstName: 'No', lastName: 'Role', email: 'norole@example.com' })

      await runSync({}, deps)

      expect(strapi.state.emails).toEqual([])
    })

    it('a second run sends nothing more', async () => {
      fiona.state.guestbooks.set(GB, guestbookWith(accreditation('acc85', 'fp85', BADGE_PRO, 'approved')))
      fiona.state.persons.set('fp85', { firstName: 'Once', lastName: 'Only', email: 'once@example.com' })
      await runSync({}, deps)
      expect(strapi.state.emails).toHaveLength(1)

      await runSync({}, deps)

      expect(strapi.state.emails).toHaveLength(1)
    })

    it('a dry run sends nothing', async () => {
      fiona.state.guestbooks.set(GB, guestbookWith(accreditation('acc86', 'fp86', BADGE_PRO, 'approved')))
      fiona.state.persons.set('fp86', { firstName: 'Dry', lastName: 'Run', email: 'dry@example.com' })

      await runSync({ dryRun: true }, deps)

      expect(strapi.state.emails).toEqual([])
    })
  })

  describe('validity of the roles a rule grants', () => {
    const withRole = (role) => {
      fiona.state.guestbooks.set(GB, guestbookWith())
      strapi.state.rules = [rule({ id: 9, name: 'jury', badge_type_id: BADGE_PRO, sync_statuses: 'approved', full_profile_statuses: 'approved', festival_editions: [{ id: CG }], user_roles: [role] })]
    }

    it('lists each granted role with its validity so a dry run shows it', async () => {
      withRole({ id: ROLE_CG, name: 'CG PERSON publisher', valid_from: null, valid_to: '2099-01-01T00:00:00.000Z' })

      const stats = await runSync({ dryRun: true }, deps)

      expect(stats.ruleRoles).toEqual([{ id: ROLE_CG, name: 'CG PERSON publisher', validFrom: null, validTo: '2099-01-01T00:00:00.000Z' }])
      expect(stats.warnings.join('\n')).not.toMatch(/role #7/)
    })

    it('warns when a granted role has no valid_to date: the publisher right then needs a purchased product and no email goes out', async () => {
      withRole({ id: ROLE_CG, name: 'CG PERSON publisher', valid_from: null, valid_to: null })

      const stats = await runSync({ dryRun: true }, deps)

      expect(stats.warnings.join('\n')).toMatch(/role #7 "CG PERSON publisher" has no valid_to/)
    })

    it('warns when a granted role has expired', async () => {
      withRole({ id: ROLE_CG, name: 'CG PERSON publisher', valid_from: null, valid_to: '2026-01-01T00:00:00.000Z' })

      const stats = await runSync({ dryRun: true }, deps)

      expect(stats.warnings.join('\n')).toMatch(/role #7 "CG PERSON publisher" expired/)
    })

    it('stays quiet when the rule data carries no validity fields at all', async () => {
      withRole({ id: ROLE_CG })

      const stats = await runSync({ dryRun: true }, deps)

      expect(stats.warnings.join('\n')).not.toMatch(/role #7/)
    })
  })

  describe('biographies', () => {
    it('asks for the person with the accreditation ids and the level', async () => {
      fiona.state.guestbooks.set(GB, guestbookWith(accreditation('acc2', 'fp2', BADGE_PRO, 'Paid')))
      fiona.state.persons.set('fp2', { firstName: 'A', lastName: 'A', email: 'a@a.ee', bio: 'Bio', bioSource: 'accreditation' })

      await runSync({}, deps)

      expect(fiona.state.personCalls).toEqual([{ personId: 'fp2', accreditationIds: ['acc2'], level: 2 }])
    })

    it('counts the biographies read from accreditation cards and names the full-profile persons that have none', async () => {
      fiona.state.guestbooks.set(GB, guestbookWith(
        accreditation('acc7', 'fp7', BADGE_PRO, 'Paid'),
        accreditation('acc8', 'fp8', BADGE_PRO, 'Paid')
      ))
      fiona.state.persons.set('fp7', { firstName: 'Card', lastName: 'Bio', email: 'b@b.ee', bio: 'From the card', bioSource: 'accreditation' })
      fiona.state.persons.set('fp8', { firstName: 'No', lastName: 'Bio', email: 'c@c.ee' })

      const stats = await runSync({}, deps)

      expect(stats.bios).toEqual({ accreditation: 1, missing: ['No Bio'] })
    })

    it('a biography from the accreditation card fills an empty biography but never overwrites an existing one', async () => {
      strapi.state.users.set(910, { id: 910, email: 'own@x.ee', person: 91, user_roles: [] })
      strapi.state.people.set(91, { id: 91, firstName: 'Own', lastName: 'Text', eMail: 'own@x.ee', bio_en: 'Written by the person', festival_editions: [], user: 910 })
      fiona.state.guestbooks.set(GB, guestbookWith(accreditation('acc9', 'fp9', BADGE_PRO, 'Paid'), accreditation('acc10', 'fp10', BADGE_PRO, 'Paid')))
      fiona.state.persons.set('fp9', { firstName: 'Own', lastName: 'Text', email: 'own@x.ee', myPoffUserId: '910', bio: 'Card text', bioSource: 'accreditation' })
      fiona.state.persons.set('fp10', { firstName: 'New', lastName: 'Person', email: 'new@x.ee', bio: 'Card text for a new person', bioSource: 'accreditation' })

      await runSync({}, deps)

      expect(strapi.state.people.get(91).bio_en).toBe('Written by the person')
      const created = [...strapi.state.people.values()].find(p => p.firstName === 'New')
      expect(created.bio_en).toBe('Card text for a new person')
    })

    it('a dry run says the biography would come from the accreditation card, with its length', async () => {
      fiona.state.guestbooks.set(GB, guestbookWith(accreditation('acc2', 'fp2', BADGE_PRO, 'Paid')))
      fiona.state.persons.set('fp2', { firstName: 'Card', lastName: 'Bio', email: 'a@a.ee', bio: 'From the card', bioSource: 'accreditation' })

      const stats = await runSync({ dryRun: true }, deps)

      expect(stats.dryRunActions[0]).toMatchObject({ action: 'CREATE', bio: 'accreditation', bioChars: 13 })
    })
  })

  describe('attaching a photo to an existing person', () => {
    const syncedWithoutPhoto = async () => {
      fiona.state.guestbooks.set(GB, guestbookWith(accreditation('acc2', 'fp2', BADGE_PRO, 'Paid')))
      fiona.state.persons.set('fp2', { firstName: 'Mari', lastName: 'Maasikas', email: 'mari@example.com' })
      await runSync({}, deps)
      return [...strapi.state.people.values()][0]
    }

    it('writes the photo to a person that was already in sync, even when nothing else changed', async () => {
      const person = await syncedWithoutPhoto()
      expect(person.picture).toBeUndefined()
      fiona.state.persons.get('fp2').photo = 'jpegbytes'
      fiona.state.persons.get('fp2').photoSource = 'headshot'

      const stats = await runSync({}, deps)

      expect(strapi.state.people.get(person.id).picture).toBe(strapi.state.uploads[0].id)
      expect(stats.persons.updated).toBe(1)
      expect(stats.persons.unchanged).toBe(0)
    })

    it('a dry run lists the photo as an update of the person and uploads nothing', async () => {
      await syncedWithoutPhoto()
      fiona.state.persons.get('fp2').photo = 'jpegbytes'
      fiona.state.persons.get('fp2').photoSource = 'headshot'

      const stats = await runSync({ dryRun: true }, deps)

      expect(stats.persons.updated).toBe(1)
      expect(stats.dryRunActions[0]).toMatchObject({ action: 'UPDATE', changed: ['picture'], photo: 'headshot' })
      expect(strapi.state.uploads).toEqual([])
    })

    it('replaces the file of an unused earlier upload in place under the new name instead of uploading a second copy', async () => {
      const person = await syncedWithoutPhoto()
      fiona.state.persons.get('fp2').photo = 'jpegbytes'
      strapi.state.orphanUploads.push({ id: 777, filename: 'fiona-person-fp2.jpg' })

      await runSync({}, deps)

      expect(strapi.state.uploads).toEqual([{ id: 777, filename: 'R_Mari_Maasikas.jpg', size: 9, replaced: true }])
      expect(strapi.state.people.get(person.id).picture).toBe(777)
    })

    it('attaches the unused earlier upload as it is when replacing its file fails', async () => {
      const person = await syncedWithoutPhoto()
      fiona.state.persons.get('fp2').photo = 'jpegbytes'
      strapi.state.orphanUploads.push({ id: 777, filename: 'fiona-person-fp2.jpg' })
      const original = strapi.uploadPhoto
      strapi.uploadPhoto = (buffer, filename, options = {}) => (options.replaceId ? null : original(buffer, filename, options))

      await runSync({}, deps)

      expect(strapi.state.people.get(person.id).picture).toBe(777)
      expect(strapi.state.uploads).toEqual([])
    })

    it('uploads a new photo as R_Firstname_Lastname.jpg', async () => {
      await syncedWithoutPhoto()
      fiona.state.persons.get('fp2').photo = 'jpegbytes'

      await runSync({}, deps)

      expect(strapi.state.uploads.map(u => u.filename)).toEqual(['R_Mari_Maasikas.jpg'])
      expect(strapi.state.uploads[0].replaced).toBe(false)
    })

    it('a second run does not touch the person again', async () => {
      await syncedWithoutPhoto()
      fiona.state.persons.get('fp2').photo = 'jpegbytes'
      await runSync({}, deps)
      const writes = strapi.state.writes.length
      const uploads = strapi.state.uploads.length

      const stats = await runSync({}, deps)

      expect(strapi.state.writes.length).toBe(writes)
      expect(strapi.state.uploads.length).toBe(uploads)
      expect(stats.persons.unchanged).toBe(1)
    })
  })

  describe('photos', () => {
    it('asks for the photo with the accreditation ids and the level of the person', async () => {
      fiona.state.guestbooks.set(GB, guestbookWith(accreditation('acc2', 'fp2', BADGE_PRO, 'Paid')))
      fiona.state.persons.set('fp2', { firstName: 'A', lastName: 'A', email: 'a@a.ee', photo: 'jpg', photoSource: 'published' })

      await runSync({}, deps)

      expect(fiona.state.photoCalls).toEqual([{ personId: 'fp2', accreditationIds: ['acc2'], level: 2, download: true }])
    })

    it('a dry run asks for the photo without downloading it', async () => {
      fiona.state.guestbooks.set(GB, guestbookWith(accreditation('acc2', 'fp2', BADGE_PRO, 'Paid')))
      fiona.state.persons.set('fp2', { firstName: 'A', lastName: 'A', email: 'a@a.ee', photo: 'jpg', photoSource: 'headshot' })

      await runSync({ dryRun: true }, deps)

      expect(fiona.state.photoCalls).toEqual([{ personId: 'fp2', accreditationIds: ['acc2'], level: 2, download: false }])
    })

    it('counts where the photos came from and names the full-profile persons that have none', async () => {
      fiona.state.guestbooks.set(GB, guestbookWith(
        accreditation('acc2', 'fp2', BADGE_PRO, 'Paid'),
        accreditation('acc7', 'fp7', BADGE_PRO, 'Paid'),
        accreditation('acc8', 'fp8', BADGE_PRO, 'Paid')
      ))
      fiona.state.persons.set('fp2', { firstName: 'Pub', lastName: 'Lished', email: 'a@a.ee', photo: 'jpg', photoSource: 'published' })
      fiona.state.persons.set('fp7', { firstName: 'Head', lastName: 'Shot', email: 'b@b.ee', photo: 'jpg', photoSource: 'headshot' })
      fiona.state.persons.set('fp8', { firstName: 'No', lastName: 'Photo', email: 'c@c.ee' })

      const stats = await runSync({}, deps)

      expect(stats.photos).toEqual({ published: 1, headshot: 1, missing: ['No Photo'] })
    })

    it('a person who already has a picture is not asked again', async () => {
      strapi.state.users.set(900, { id: 900, email: 'p@p.ee', person: 90, user_roles: [] })
      strapi.state.people.set(90, { id: 90, firstName: 'Has', lastName: 'Pic', eMail: 'p@p.ee', picture: 5, festival_editions: [], user: 900 })
      fiona.state.guestbooks.set(GB, guestbookWith(accreditation('acc9', 'fp9', BADGE_PRO, 'Paid')))
      fiona.state.persons.set('fp9', { firstName: 'Has', lastName: 'Pic', email: 'p@p.ee', myPoffUserId: '900', photo: 'jpg' })

      await runSync({}, deps)

      expect(fiona.state.photoCalls).toEqual([])
    })

    it('a dry run also says when there was a choice between several headshots and how it was made', async () => {
      fiona.state.guestbooks.set(GB, guestbookWith(accreditation('acc2', 'fp2', BADGE_PRO, 'Paid')))
      fiona.state.persons.set('fp2', { firstName: 'Karin', lastName: 'P', email: 'a@a.ee', photo: 'jpg', photoSource: 'headshot', photoChoice: 'default' })

      const stats = await runSync({ dryRun: true }, deps)

      expect(stats.dryRunActions[0]).toMatchObject({ photo: 'headshot', photoChoice: 'default' })
    })

    it('a dry run says which source each photo would come from and writes nothing', async () => {
      fiona.state.guestbooks.set(GB, guestbookWith(accreditation('acc2', 'fp2', BADGE_PRO, 'Paid')))
      fiona.state.persons.set('fp2', { firstName: 'Head', lastName: 'Shot', email: 'a@a.ee', photo: 'jpg', photoSource: 'headshot' })

      const stats = await runSync({ dryRun: true }, deps)

      expect(stats.dryRunActions[0]).toMatchObject({ action: 'CREATE', photo: 'headshot' })
      expect(strapi.state.uploads).toEqual([])
    })
  })

  it('shows in its stats whether the unpublished photo and biography switches are on', async () => {
    fiona.state.guestbooks.set(GB, guestbookWith())
    expect((await runSync({ dryRun: true }, deps)).switches).toEqual({ unpublishedPhotos: false, unpublishedBios: false })

    deps.config.unpublishedPhotos = true
    deps.config.unpublishedBios = true
    expect((await runSync({ dryRun: true }, deps)).switches).toEqual({ unpublishedPhotos: true, unpublishedBios: true })
  })

  it('reports per rule how many persons it matches, and how many of them get the full profile', async () => {
    fiona.state.guestbooks.set(GB, guestbookWith(
      accreditation('acc1', 'fp1', BADGE_TEAM, 'approved'),
      accreditation('acc2', 'fp2', BADGE_PRO, 'Paid'),
      accreditation('acc3', 'fp3', BADGE_PRO, 'Paid')
    ))
    for (const id of ['fp1', 'fp2', 'fp3']) fiona.state.persons.set(id, { firstName: id, lastName: 'X', email: `${id}@x.ee` })

    const stats = await runSync({ dryRun: true }, deps)

    expect(stats.rules.detail).toEqual([
      { id: 1, name: 'TEAM → basic', targetBuilds: false, persons: 1, fullProfile: 0 },
      { id: 2, name: 'Industry PRO → full', targetBuilds: false, persons: 2, fullProfile: 2 }
    ])
  })

  describe('import in steps: the cap of persons written per run', () => {
    const many = (n) => {
      const accreditations = []
      for (let i = 1; i <= n; i++) {
        accreditations.push(accreditation(`acc${i}`, `fp${i}`, BADGE_PRO, 'Paid'))
        fiona.state.persons.set(`fp${i}`, { firstName: `P${i}`, lastName: 'X', email: `p${i}@x.ee` })
      }
      fiona.state.guestbooks.set(GB, guestbookWith(...accreditations))
    }

    it('stops after the cap of persons written and says that more work remains', async () => {
      deps.config.maxPersonsPerRun = 2
      many(5)

      const stats = await runSync({}, deps)

      expect(stats.persons.created).toBe(2)
      expect(strapi.state.people.size).toBe(2)
      expect(stats.backlog).toMatchObject({ cap: 2, more: true })
    })

    it('the next runs carry on with the rest, and a run that writes less than the cap ends the backlog', async () => {
      deps.config.maxPersonsPerRun = 2
      many(5)
      await runSync({}, deps)
      const second = await runSync({ backlog: true }, deps)
      expect(second.persons.created).toBe(2)
      expect(second.backlog.more).toBe(true)

      const third = await runSync({ backlog: true }, deps)

      expect(third.persons.created).toBe(1)
      expect(third.backlog.more).toBe(false)
      expect(strapi.state.people.size).toBe(5)
    })

    it('a backlog run leaves the persons the run before wrote alone, without asking Fiona or Strapi about them', async () => {
      deps.config.maxPersonsPerRun = 2
      many(4)
      await runSync({}, deps)
      fiona.state.personCalls.length = 0

      await runSync({ backlog: true }, deps)

      expect(fiona.state.personCalls.map(c => c.personId)).toEqual(['fp3', 'fp4'])
    })

    it('persons that are already in sync do not count toward the cap', async () => {
      many(2)
      await runSync({}, deps)
      deps.config.maxPersonsPerRun = 1
      many(4)

      const stats = await runSync({}, deps)

      expect(stats.persons.unchanged).toBe(2)
      expect(stats.persons.created).toBe(1)
      expect(stats.backlog.more).toBe(true)
    })

    it('when fewer persons need a write than the cap there is no backlog', async () => {
      deps.config.maxPersonsPerRun = 5
      many(3)

      const stats = await runSync({}, deps)

      expect(stats.persons.created).toBe(3)
      expect(stats.backlog.more).toBe(false)
    })

    it('a cap of 0 means no cap', async () => {
      deps.config.maxPersonsPerRun = 0
      many(6)

      const stats = await runSync({}, deps)

      expect(stats.persons.created).toBe(6)
      expect(stats.backlog.more).toBe(false)
    })

    it('persons after the cap cost no photo lookup at all', async () => {
      deps.config.maxPersonsPerRun = 1
      many(3)
      for (const id of ['fp1', 'fp2', 'fp3']) { fiona.state.persons.get(id).photo = 'jpg'; fiona.state.persons.get(id).photoSource = 'headshot' }

      await runSync({}, deps)

      expect(strapi.state.uploads).toHaveLength(1)
      expect(fiona.state.photoCalls.map(c => c.personId)).toEqual(['fp1'])
    })

    it('a dry run ignores the cap, lists everything and says how many runs the import needs', async () => {
      deps.config.maxPersonsPerRun = 2
      many(5)

      const stats = await runSync({ dryRun: true }, deps)

      expect(stats.persons.created).toBe(5)
      expect(stats.backlog).toEqual({ cap: 2, more: false, planned: 5, runsNeeded: 3 })
    })
  })

  describe('more than one job entry with the same key', () => {
    const entry = (id, overrides = {}) => ({
      id,
      key: 'accreditations',
      name: `entry ${id}`,
      enabled: true,
      incremental_interval_minutes: 15,
      full_run_hour: 3,
      mutation_cursor: '2026-10-27T10:00:00.000Z',
      last_incremental_run_at: '2026-10-27T10:00:00.000Z',
      last_full_run_at: '2026-10-26T01:00:00.000Z',
      last_stats: null,
      ...overrides
    })

    it('keeps the automatic mode off and says why, so a second entry cannot start a run nobody expects', async () => {
      strapi.state.syncJob = entry(1)
      strapi.state.extraJobs = [entry(2, { enabled: false })]

      const stats = await runSync({ mode: 'auto' }, deps)

      expect(stats.skipped).toBe(true)
      expect(stats.reason).toMatch(/2 fiona-sync-job entries/)
      expect(stats.reason).toMatch(/#1, #2/)
    })

    it('a manual run still works, warns about the second entry and keeps its state in the entry with the lowest id', async () => {
      strapi.state.syncJob = entry(1)
      strapi.state.extraJobs = [entry(2, { enabled: false })]
      fiona.state.guestbooks.set(GB, guestbookWith())

      const stats = await runSync({}, deps)

      expect(stats.warnings.join('\n')).toMatch(/2 fiona-sync-job entries/)
      expect(stats.job).toMatchObject({ id: 1, duplicates: [2] })
      expect(strapi.state.syncJob.last_stats).toBeTruthy()
    })

    it('shows in the stats which job entry is used and its schedule', async () => {
      strapi.state.syncJob = entry(7, { enabled: false })
      fiona.state.guestbooks.set(GB, guestbookWith())

      const stats = await runSync({ dryRun: true }, deps)

      expect(stats.job).toEqual({
        id: 7,
        name: 'entry 7',
        enabled: false,
        incrementalIntervalMinutes: 15,
        fullRunHour: 3,
        lastFullRunAt: '2026-10-26T01:00:00.000Z',
        lastIncrementalRunAt: '2026-10-27T10:00:00.000Z',
        duplicates: []
      })
    })

    it('hands the stats object to the caller as soon as the run starts, so a long run can be watched', async () => {
      fiona.state.guestbooks.set(GB, guestbookWith())
      let seen = null
      deps.onStart = (stats) => { seen = stats }

      const stats = await runSync({ dryRun: true }, deps)

      expect(seen).toBe(stats)
    })
  })

  describe('a test run: only the persons of chosen rules, at most a few, and no job state saved', () => {
    const entry = () => ({
      id: 1,
      key: 'accreditations',
      name: 'job',
      enabled: false,
      incremental_interval_minutes: 15,
      full_run_hour: 3,
      mutation_cursor: null,
      last_incremental_run_at: null,
      last_full_run_at: null,
      last_stats: null
    })
    const mixed = () => {
      fiona.state.guestbooks.set(GB, guestbookWith(
        accreditation('acc1', 'fp1', BADGE_TEAM, 'approved'),
        accreditation('acc2', 'fp2', BADGE_PRO, 'Paid'),
        accreditation('acc3', 'fp3', BADGE_PRO, 'Paid'),
        accreditation('acc4', 'fp4', BADGE_PRO, 'Paid'),
        accreditation('acc5', 'fp5', BADGE_TEAM, 'approved')
      ))
      for (let i = 1; i <= 5; i++) fiona.state.persons.set(`fp${i}`, { firstName: `P${i}`, lastName: 'X', email: `p${i}@x.ee` })
    }

    it('handles only the persons the chosen rules match, and at most the given number', async () => {
      mixed()

      const stats = await runSync({ only: { ruleIds: [2], maxPersons: 2 } }, deps)

      const names = [...strapi.state.people.values()].map(p => p.firstName).sort()
      expect(names).toEqual(['P2', 'P3'])
      expect(stats.persons.created).toBe(2)
      expect(stats.test).toEqual({ ruleIds: [2], maxPersons: 2, scope: 'all', outsideRules: 2, alreadyInStrapi: 0 })
    })

    it('saves no state in the job entry, so a test cannot start, delay or shorten the real import', async () => {
      strapi.state.syncJob = entry()
      mixed()

      await runSync({ only: { ruleIds: [2], maxPersons: 2 } }, deps)

      expect(strapi.state.syncJob.last_full_run_at).toBeNull()
      expect(strapi.state.syncJob.last_stats).toBeNull()
      expect(strapi.state.writes.some(w => w.op === 'saveSyncJob')).toBe(false)
    })

    it('without a test the same run handles everyone, as before', async () => {
      mixed()

      const stats = await runSync({}, deps)

      expect(stats.persons.created).toBe(5)
      expect(stats.test).toBeUndefined()
    })

    it('a dry run with a test filter lists only those persons', async () => {
      mixed()

      const stats = await runSync({ dryRun: true, only: { ruleIds: [2], maxPersons: 2 } }, deps)

      expect(stats.dryRunActions.map(a => a.name)).toEqual(['P2 X', 'P3 X', 'P4 X'])
      expect(stats.persons.created).toBe(3)
    })

    it('can be limited to persons that are not in Strapi yet, so the test shows the creation of new persons', async () => {
      mixed()
      strapi.state.users.set(900, { id: 900, email: 'p2@x.ee', person: 92, user_roles: [] })
      strapi.state.people.set(92, { id: 92, firstName: 'P2', lastName: 'X', eMail: 'p2@x.ee', festival_editions: [], user: 900 })
      fiona.state.persons.get('fp2').myPoffUserId = '900'

      const stats = await runSync({ only: { ruleIds: [2], maxPersons: 5, scope: 'new' } }, deps)

      const created = [...strapi.state.people.values()].filter(p => p.id !== 92).map(p => p.firstName).sort()
      expect(created).toEqual(['P3', 'P4'])
      expect(strapi.state.people.get(92).fiona_person_id).toBeUndefined()
      expect(stats.test.scope).toBe('new')
      expect(stats.test.alreadyInStrapi).toBe(1)
    })

    it('can be limited to persons that already exist, so the test shows how a profile is adopted', async () => {
      mixed()
      strapi.state.users.set(900, { id: 900, email: 'p2@x.ee', person: 92, user_roles: [] })
      strapi.state.people.set(92, { id: 92, firstName: 'P2', lastName: 'X', eMail: 'p2@x.ee', festival_editions: [], user: 900 })
      fiona.state.persons.get('fp2').myPoffUserId = '900'

      const stats = await runSync({ only: { ruleIds: [2], maxPersons: 5, scope: 'existing' } }, deps)

      expect(strapi.state.people.size).toBe(1)
      expect(strapi.state.people.get(92).fiona_person_id).toBe('fp2')
      expect(stats.persons.created).toBe(0)
    })

    it('needs at least one rule id', async () => {
      mixed()
      await expect(runSync({ only: { ruleIds: [], maxPersons: 2 } }, deps)).rejects.toThrow(/rule id/)
    })
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

    const [personId] = [...strapi.state.people.keys()]
    expect(stats.dryRunActions).toEqual([{ action: 'UNPUBLISH', fionaPersonId: 'fp2', personId, detachEditionIds: [CG, IND], removeRoleIds: [ROLE_CG] }])
  })

  describe('site builds of changed persons', () => {
    const touches = () => strapi.state.writes.filter(w => w.op === 'updatePerson' && w.payload.skipbuild !== true)
    const job = () => ({
      id: 1,
      key: 'accreditations',
      enabled: true,
      incremental_interval_minutes: 15,
      full_run_hour: 3,
      mutation_cursor: null,
      last_incremental_run_at: null,
      last_full_run_at: null,
      last_stats: null,
      last_error: null,
      build_queue: null
    })
    const buildRule = (overrides = {}) => ({ ...PRO_RULE, target_builds: true, ...overrides })
    const three = () => {
      fiona.state.guestbooks.set(GB, guestbookWith(
        accreditation('acc2', 'fp2', BADGE_PRO, 'Paid'),
        accreditation('acc7', 'fp7', BADGE_PRO, 'Paid'),
        accreditation('acc8', 'fp8', BADGE_PRO, 'Paid')
      ))
      fiona.state.persons.set('fp2', { firstName: 'A', lastName: 'A', email: 'a@a.ee' })
      fiona.state.persons.set('fp7', { firstName: 'B', lastName: 'B', email: 'b@b.ee' })
      fiona.state.persons.set('fp8', { firstName: 'C', lastName: 'C', email: 'c@c.ee' })
    }
    const one = () => {
      fiona.state.guestbooks.set(GB, guestbookWith(accreditation('acc2', 'fp2', BADGE_PRO, 'Paid')))
      fiona.state.persons.set('fp2', { firstName: 'A', lastName: 'A', email: 'a@a.ee' })
    }

    it('builds nothing when the rule does not switch builds on', async () => {
      one()

      const stats = await runSync({}, deps)

      expect(touches()).toHaveLength(0)
      expect(stats.build).toMatchObject({ triggered: false, ids: [], queued: 0, candidates: 0 })
    })

    it('builds a changed person right away when the rule switches builds on', async () => {
      strapi.state.rules = [TEAM_RULE, buildRule({ target_builds_limit_per_run: 5 })]
      one()

      const stats = await runSync({}, deps)

      expect(touches()).toHaveLength(1)
      const person = [...strapi.state.people.values()][0]
      expect(stats.build).toMatchObject({ triggered: true, ids: [person.id], queued: 0 })
    })

    it('builds the limit amount now and keeps the rest on a waiting list', async () => {
      strapi.state.rules = [TEAM_RULE, buildRule({ target_builds_limit_per_run: 2 })]
      strapi.state.syncJob = job()
      three()

      const stats = await runSync({}, deps)

      expect(touches()).toHaveLength(2)
      expect(stats.build.ids).toHaveLength(2)
      expect(stats.build.queued).toBe(1)
      expect(strapi.state.syncJob.build_queue).toHaveLength(1)
      expect(strapi.state.syncJob.build_queue[0]).toMatchObject({ ruleIds: [2] })
    })

    it('the next run builds the next limit amount from the waiting list', async () => {
      strapi.state.rules = [TEAM_RULE, buildRule({ target_builds_limit_per_run: 2 })]
      strapi.state.syncJob = job()
      three()
      await runSync({}, deps)
      const waiting = strapi.state.syncJob.build_queue[0].personId

      const stats = await runSync({}, deps)

      expect(touches()).toHaveLength(3)
      expect(stats.build.ids).toEqual([waiting])
      expect(stats.build.queued).toBe(0)
      expect(strapi.state.syncJob.build_queue).toEqual([])
    })

    it('an empty limit falls back to the global default', async () => {
      deps.config.maxBuildsPerRun = 1
      strapi.state.rules = [TEAM_RULE, buildRule()]
      strapi.state.syncJob = job()
      three()

      const stats = await runSync({}, deps)

      expect(touches()).toHaveLength(1)
      expect(stats.build.queued).toBe(2)
    })

    it('switching a rule off drops its waiting persons without building them', async () => {
      strapi.state.rules = [TEAM_RULE, buildRule({ target_builds_limit_per_run: 1 })]
      strapi.state.syncJob = job()
      three()
      await runSync({}, deps)
      expect(strapi.state.syncJob.build_queue).toHaveLength(2)
      strapi.state.rules = [TEAM_RULE, PRO_RULE]

      const stats = await runSync({}, deps)

      expect(touches()).toHaveLength(1)
      expect(stats.build.queued).toBe(0)
      expect(strapi.state.syncJob.build_queue).toEqual([])
    })

    it('a person matched by two rules is built when one of them has builds on', async () => {
      strapi.state.rules = [TEAM_RULE, PRO_RULE, buildRule({ id: 3, name: 'second rule for the same badge', target_builds_limit_per_run: 5 })]
      one()

      await runSync({}, deps)

      expect(touches()).toHaveLength(1)
    })

    it('a basic (level 1) person is never built', async () => {
      strapi.state.rules = [buildRule({ id: 1, name: 'team', badge_type_id: BADGE_TEAM, badge_type_name: 'TEAM', sync_statuses: 'approved', full_profile_statuses: '', festival_editions: [], user_roles: [] })]
      fiona.state.guestbooks.set(GB, guestbookWith(accreditation('acc3', 'fp3', BADGE_TEAM, 'approved')))
      fiona.state.persons.set('fp3', { firstName: 'T', lastName: 'T', email: 't@t.ee' })

      const stats = await runSync({}, deps)

      expect(touches()).toHaveLength(0)
      expect(stats.build.candidates).toBe(0)
    })

    it('never builds a person the sync takes off Creative Gate, and says the page stays until the next full build', async () => {
      strapi.state.rules = [TEAM_RULE, buildRule({ target_builds_limit_per_run: 5 })]
      one()
      await runSync({}, deps)
      expect(touches()).toHaveLength(1)
      fiona.state.guestbooks.get(GB).accreditations[0].badges[0].statusText = 'Cancelled'

      const stats = await runSync({}, deps)

      const [personId] = [...strapi.state.people.keys()]
      expect(touches()).toHaveLength(1)
      expect(stats.persons.unpublished).toBe(1)
      expect(stats.build.removedWithoutBuild).toEqual([personId])
      expect(stats.warnings.join('\n')).toMatch(/full build/i)
    })

    it('a waiting person who is then taken off Creative Gate is dropped from the list and never built', async () => {
      strapi.state.rules = [TEAM_RULE, buildRule({ target_builds_limit_per_run: 1 })]
      strapi.state.syncJob = job()
      three()
      await runSync({}, deps)
      const waiting = strapi.state.syncJob.build_queue
      expect(waiting).toHaveLength(2)
      const removed = strapi.state.people.get(waiting[1].personId)
      fiona.state.guestbooks.get(GB).accreditations.find(a => a.personId === removed.fiona_person_id).badges[0].statusText = 'Cancelled'

      const stats = await runSync({}, deps)

      expect(stats.build.ids).toEqual([waiting[0].personId])
      expect(stats.build.removedWithoutBuild).toEqual([removed.id])
      expect(strapi.state.syncJob.build_queue).toEqual([])
    })

    it('a dry run builds nothing, keeps the waiting list as it is and says how many persons it would queue', async () => {
      strapi.state.rules = [TEAM_RULE, buildRule({ target_builds_limit_per_run: 5 })]
      strapi.state.syncJob = job()
      one()

      const stats = await runSync({ dryRun: true }, deps)

      expect(touches()).toHaveLength(0)
      expect(stats.build.candidates).toBe(1)
      expect(strapi.state.syncJob.build_queue).toBeNull()
    })

    it('while the job entry has no build_queue field yet, the rest of the job state still saves and the run says a full build is needed', async () => {
      strapi.state.rules = [TEAM_RULE, buildRule({ target_builds_limit_per_run: 1 })]
      const { build_queue: notThereYet, ...withoutField } = job()
      strapi.state.syncJob = withoutField
      three()

      const stats = await runSync({}, deps)

      expect(touches()).toHaveLength(1)
      expect(strapi.state.syncJob).not.toHaveProperty('build_queue')
      expect(strapi.state.syncJob.last_stats).toBeTruthy()
      expect(stats.warnings.join('\n')).toMatch(/full build/i)
    })

    it('without a job entry there is nowhere to keep a waiting list: builds the limit and says the rest needs a full build', async () => {
      strapi.state.rules = [TEAM_RULE, buildRule({ target_builds_limit_per_run: 1 })]
      three()

      const stats = await runSync({}, deps)

      expect(touches()).toHaveLength(1)
      expect(stats.warnings.join('\n')).toMatch(/full build/i)
    })
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

describe('decideAutoMode with a backlog', () => {
  const job = (overrides = {}) => ({
    id: 1,
    key: 'accreditations',
    enabled: true,
    incremental_interval_minutes: 15,
    full_run_hour: 3,
    mutation_cursor: '2026-10-27T10:00:00.000Z',
    last_incremental_run_at: '2026-10-27T11:00:00.000Z',
    last_full_run_at: '2026-10-27T01:00:00.000Z',
    last_stats: null,
    ...overrides
  })

  it('runs a backlog run two minutes after a run that stopped at the cap, without waiting for the interval or the night', () => {
    const j = job({ last_stats: { backlog: { more: true } }, last_full_run_at: '2026-10-27T11:20:00.000Z' })
    expect(decideAutoMode(j, new Date('2026-10-27T11:22:30.000Z'))).toEqual({ skipped: false, mode: 'full', backlog: true })
  })

  it('waits for the two minutes after the last run', () => {
    const j = job({ last_stats: { backlog: { more: true } }, last_full_run_at: '2026-10-27T11:20:00.000Z' })
    const decision = decideAutoMode(j, new Date('2026-10-27T11:21:00.000Z'))
    expect(decision.skipped).toBe(true)
    expect(decision.reason).toMatch(/backlog/i)
  })

  it('does nothing special when the last run left no work', () => {
    const j = job({ last_stats: { backlog: { more: false } }, last_incremental_run_at: '2026-10-27T11:20:00.000Z' })
    expect(decideAutoMode(j, new Date('2026-10-27T11:22:30.000Z')).skipped).toBe(true)
  })

  it('a disabled job stays disabled whatever the backlog', () => {
    const j = job({ enabled: false, last_stats: { backlog: { more: true } } })
    expect(decideAutoMode(j, new Date('2026-10-27T11:22:30.000Z')).reason).toMatch(/disabled/)
  })
})
