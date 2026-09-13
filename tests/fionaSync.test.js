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
    failPersons: new Set()
  }
  const gb = (id) => {
    if (state.failGuestbooks.has(id)) throw new Error(`fiona down for ${id}`)
    return state.guestbooks.get(id) || { badges: [], accreditations: [] }
  }
  const findAcc = (accId) => {
    for (const g of state.guestbooks.values()) {
      const acc = g.accreditations.find(a => a.id === accId)
      if (acc) return acc
    }
    throw new Error(`no accreditation ${accId}`)
  }
  return {
    state,
    listGuestbookBadges (id) { return gb(id).badges },
    listAccreditations (id) { return gb(id).accreditations.map(a => ({ id: a.id })) },
    getAccreditationBadges (accId) { return findAcc(accId).badges },
    getAccreditation (accId) {
      const a = findAcc(accId)
      return { personId: a.personId, noPublicationOfContactDetails: !!a.noPublicationOfContactDetails, films: [] }
    },
    getPerson (personId) {
      if (state.failPersons.has(personId)) throw new Error(`person ${personId} unavailable`)
      const p = state.persons.get(personId)
      if (!p) throw new Error(`no person ${personId}`)
      return { firstName: p.firstName, lastName: p.lastName, email: p.email, phone: p.phone || null, bio: p.bio || null }
    },
    getMyPoffUserId (personId) { return state.persons.get(personId)?.myPoffUserId || null },
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
    findOrRegisterUser (email) {
      let u = [...state.users.values()].find(u => u.email.toLowerCase() === email.toLowerCase())
      let created = false
      if (!u) {
        u = { id: nextId(), email, person: null, user_roles: [] }
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
      if (state.profiles.has(Number(user.id))) return false
      state.profiles.set(Number(user.id), { user: Number(user.id), ...fields })
      state.writes.push({ op: 'createProfile', id: Number(user.id), payload: { ...fields } })
      return true
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
    badge_id: BADGE_TEAM,
    badge_name: 'TEAM',
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
  badge_id: BADGE_PRO,
  badge_name: 'Industry PRO',
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
    expect(stats.profiles.created).toBe(1)
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

  it('never removes when no active rule maps to a scanned guestbook', async () => {
    fiona.state.guestbooks.set(GB, guestbookWith(accreditation('acc2', 'fp2', BADGE_PRO, 'Paid')))
    fiona.state.persons.set('fp2', { firstName: 'Jaan', lastName: 'Tamm', email: 'jaan@example.com' })
    await runSync({}, deps)
    strapi.state.rules = [rule({ id: 9, badge_id: 'unknown-badge', badge_name: 'Nobody' })]

    const stats = await runSync({}, deps)

    expect(stats.persons.unpublished).toBe(0)
    expect(stats.rules).toMatchObject({ active: 1, mapped: 0, unmapped: 1 })
    expect(log.lines.warn.join('\n')).toMatch(/removal phase skipped/)
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
})
