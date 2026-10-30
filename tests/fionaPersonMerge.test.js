import { describe, it, expect, vi } from 'vitest'
import { planMerge, mergePersons, mergeBatch } from '../server/utils/fiona/personMerge.js'

const silent = { info () {}, warn () {}, error () {} }
const clone = value => JSON.parse(JSON.stringify(value))

const person = (id, extra = {}) => ({
  id,
  firstName: 'Mari',
  lastName: 'Maasikas',
  firstNameLastName: 'Mari Maasikas',
  eMail: null,
  phoneNr: null,
  bio_en: null,
  fiona_person_id: null,
  fiona_accreditation_id: null,
  fiona_guestbook_ids: null,
  fiona_attached_edition_ids: null,
  fiona_assigned_role_ids: null,
  fiona_synced_at: null,
  fiona_unpublished_at: null,
  remoteId: null,
  eventival_id: null,
  slug_et: 'mari-maasikas',
  slug_en: 'mari-maasikas',
  slug_ru: 'mari-maasikas',
  public: null,
  show_in_cg_search: null,
  user: null,
  addr_coll: null,
  picture: null,
  profile_img: null,
  images: [],
  organisations: [],
  festival_editions: [],
  industry_categories: [],
  role_at_films: [],
  orderedRaF: [],
  biography: null,
  gender: null,
  updated_at: '2026-01-01T00:00:00.000Z',
  ...extra
})

const OLD = person(20, { eMail: null, phoneNr: '555', bio_en: 'old bio', updated_at: '2020-05-01T00:00:00.000Z', picture: { id: 7 }, festival_editions: [{ id: 80 }], organisations: [{ id: 1 }] })
const COPY = person(500, {
  eMail: 'mari@acme.ee',
  bio_en: 'new bio',
  fiona_person_id: 'f-1',
  fiona_accreditation_id: 'a-1',
  fiona_guestbook_ids: 'g-1',
  fiona_attached_edition_ids: '86',
  fiona_assigned_role_ids: '11',
  fiona_synced_at: '2026-10-28T10:00:00.000Z',
  slug_et: 'mari-maasikas-1',
  slug_en: 'mari-maasikas-1',
  slug_ru: 'mari-maasikas-1',
  public: true,
  show_in_cg_search: true,
  user: { id: 70 },
  picture: { id: 9 },
  festival_editions: [{ id: 86 }],
  organisations: [{ id: 1 }, { id: 2 }],
  industry_categories: [{ id: 4 }],
  addr_coll: { id: 40, country: { id: 7 } },
  updated_at: '2026-10-28T10:00:00.000Z'
})

describe('planMerge: when a pair is not merged', () => {
  const skip = (over, expected) => {
    const plan = planMerge({ keep: OLD, remove: COPY, ...over })
    expect(plan.ok).toBe(false)
    expect(plan.reason).toMatch(expected)
  }

  it('refuses the same record, different names, and a record to remove that is used somewhere', () => {
    skip({ remove: OLD }, /same record/)
    skip({ remove: person(501, { firstNameLastName: 'Jaan Tamm', firstName: 'Jaan', lastName: 'Tamm' }) }, /names differ/)
    skip({ removeRefs: [{ source: 'film', id: 12 }] }, /used in film #12/)
  })

  it('refuses two sync-managed records with different Fiona ids, two different login users, and two different Eventival ids', () => {
    skip({ keep: person(20, { fiona_person_id: 'f-9' }) }, /different Fiona ids/)
    skip({ keep: person(20, { user: { id: 71 } }) }, /different login users/)
    skip({ keep: person(20, { remoteId: '991' }), remove: person(500, { remoteId: '992' }) }, /different remoteId/)
  })

  it('accepts the same login user on both records and the same Fiona id on both', () => {
    expect(planMerge({ keep: person(20, { user: { id: 70 } }), remove: COPY }).ok).toBe(true)
    expect(planMerge({ keep: person(20, { fiona_person_id: 'f-1' }), remove: COPY }).ok).toBe(true)
  })
})

describe('planMerge: Eventival ids that differ', () => {
  const a = person(20, { remoteId: '377071' })
  const b = person(500, { remoteId: '497824', fiona_person_id: 'f-1', updated_at: '2026-10-28T10:00:00.000Z' })

  it('refuses two different Eventival ids, unless told they cannot be trusted', () => {
    expect(planMerge({ keep: a, remove: b }).reason).toMatch(/different remoteId/)

    const plan = planMerge({ keep: a, remove: b, ignoreEventivalIds: true })

    expect(plan.ok).toBe(true)
    expect('remoteId' in plan.patch).toBe(false) // the kept record's own id stays
  })
})

describe('planMerge: what the kept record gets', () => {
  const plan = planMerge({ keep: OLD, remove: COPY })

  it('takes the value of the most recently updated record when both have one, and fills gaps from the other', () => {
    expect(plan.patch.eMail).toBe('mari@acme.ee') // only the copy has one
    expect(plan.patch.bio_en).toBe('new bio') // both have one: the copy is newer
    expect(plan.patch.phoneNr).toBeUndefined() // only the old record has one: unchanged
    expect(plan.patch.picture).toBe(9) // both have one: the copy is newer
    const older = planMerge({ keep: person(20, { bio_en: 'kept bio', updated_at: '2026-12-01T00:00:00.000Z' }), remove: COPY })
    expect(older.patch.bio_en).toBeUndefined() // the kept record is the newer one
  })

  it('never changes the name fields, and the slugs only when the kept record has none', () => {
    expect(plan.patch.firstName).toBeUndefined()
    expect(plan.patch.firstNameLastName).toBeUndefined()
    expect(plan.patch.slug_en).toBeUndefined()
    const noSlugs = planMerge({ keep: person(20, { slug_et: null, slug_en: '', slug_ru: null }), remove: COPY })
    expect(noSlugs.patch).toMatchObject({ slug_et: 'mari-maasikas-1', slug_en: 'mari-maasikas-1', slug_ru: 'mari-maasikas-1' })
    expect(noSlugs.preRemovePatch).toEqual({ slug_et: null, slug_en: null, slug_ru: null }) // a uid is unique: freed on the other record first
  })

  it('takes the Fiona ids from the sync-managed record, and nothing when the kept record holds them already', () => {
    expect(plan.patch).toMatchObject({
      fiona_person_id: 'f-1',
      fiona_accreditation_id: 'a-1',
      fiona_guestbook_ids: 'g-1',
      fiona_attached_edition_ids: '86',
      fiona_assigned_role_ids: '11',
      fiona_synced_at: '2026-10-28T10:00:00.000Z'
    })
    const reversed = planMerge({ keep: COPY, remove: OLD })
    expect(reversed.ok).toBe(true)
    expect(Object.keys(reversed.patch).filter(key => key.startsWith('fiona_'))).toEqual([])
  })

  it('is public if either record is, and shown in Creative Gate search if either is', () => {
    expect(plan.patch).toMatchObject({ public: true, show_in_cg_search: true })
    expect(planMerge({ keep: person(20, { public: true }), remove: person(500, { public: false }) }).patch.public).toBeUndefined()
  })

  it('adds the relations of both records together (ids only, nothing taken away)', () => {
    expect(plan.patch.organisations).toEqual([1, 2])
    expect(plan.patch.festival_editions).toEqual([80, 86])
    expect(plan.patch.industry_categories).toEqual([4])
    expect(plan.patch.domains).toBeUndefined()
    const same = planMerge({ keep: person(20, { organisations: [{ id: 1 }, { id: 2 }] }), remove: COPY })
    expect(same.patch.organisations).toBeUndefined()
  })

  it('fills a single relation that is empty and lets the newer record win when both have one; file lists are added together', () => {
    const both = planMerge({ keep: person(20, { gender: { id: 1 }, images: [{ id: 5 }] }), remove: person(500, { gender: { id: 2 }, images: [{ id: 5 }, { id: 6 }], updated_at: '2026-10-28T00:00:00.000Z' }) })
    expect(both.patch.gender).toBe(2)
    expect(both.patch.images).toEqual([5, 6])
    expect(planMerge({ keep: person(20, { gender: { id: 1 } }), remove: person(500, { gender: null }) }).patch.gender).toBeUndefined()
  })

  it('adds the roles of the other record at the end of the ordered roles and keeps the existing rows with their ids', () => {
    const keep = person(20, { orderedRaF: [{ id: 900, order: 3, role_at_film: { id: 13 } }] })
    const remove = person(500, { orderedRaF: [{ id: 901, order: 1, role_at_film: { id: 11 } }, { id: 902, order: 2, role_at_film: { id: 13 } }, { id: 903, order: 3, role_at_film: null }] })

    const result = planMerge({ keep, remove })

    expect(result.patch.orderedRaF).toEqual([{ id: 900, order: 3, role_at_film: 13 }, { order: 4, role_at_film: 11 }])
    expect(planMerge({ keep: remove, remove: keep }).patch.orderedRaF).toBeUndefined() // it has role 13 already
  })

  it('copies a single component (biography) only into an empty one, without the ids of the other record', () => {
    const remove = person(500, { biography: { id: 77, en: 'Text', et: 'Tekst' } })
    expect(planMerge({ keep: OLD, remove }).patch.biography).toEqual({ en: 'Text', et: 'Tekst' })
    expect(planMerge({ keep: person(20, { biography: { id: 5, en: 'Mine' } }), remove }).patch.biography).toBeUndefined()
  })

  it('writes nothing when there is nothing to add', () => {
    const result = planMerge({ keep: COPY, remove: person(21, { phoneNr: null }) })
    expect(result.ok).toBe(true)
    expect(result.patch).toEqual({})
    expect(result.changes).toEqual([])
  })
})

describe('planMerge: login user, address, and the retired record', () => {
  it('links the login user to the kept record, from whichever record has one', () => {
    expect(planMerge({ keep: OLD, remove: COPY }).link.userId).toBe(70)
    expect(planMerge({ keep: person(20, { user: { id: 70 } }), remove: COPY }).link.userId).toBe(70)
    expect(planMerge({ keep: OLD, remove: person(500) }).link.userId).toBeNull()
  })

  it('moves the address when the kept record has none, and fills its country when that is empty', () => {
    expect(planMerge({ keep: OLD, remove: COPY }).link.addressMove).toBe(40)
    const fill = planMerge({ keep: person(20, { addr_coll: { id: 41, country: null } }), remove: COPY })
    expect(fill.link.addressMove).toBeNull()
    expect(fill.link.addressCountry).toEqual({ addressId: 41, countryId: 7 })
    const has = planMerge({ keep: person(20, { addr_coll: { id: 41, country: { id: 8 } } }), remove: COPY })
    expect(has.link.addressCountry).toBeNull()
  })

  it('hides the retired record and takes everything off it that another lookup could find', () => {
    const result = planMerge({ keep: OLD, remove: COPY })
    expect(result.retirePatch).toMatchObject({
      fiona_person_id: null,
      fiona_accreditation_id: null,
      fiona_guestbook_ids: null,
      fiona_attached_edition_ids: null,
      fiona_assigned_role_ids: null,
      fiona_synced_at: null,
      fiona_unpublished_at: null,
      eMail: null,
      public: false,
      show_in_cg_search: false,
      user: null
    })
  })

  it('marks the retired record as archived in its last name and full name, so it is recognised in the admin and no longer matches a name search', () => {
    const result = planMerge({ keep: OLD, remove: COPY })
    expect(result.retirePatch).toMatchObject({ lastName: 'Maasikas (archived)', firstNameLastName: 'Mari Maasikas (archived)' })
    expect(result.retirePatch.firstName).toBeUndefined()
    expect(result.patch.lastName).toBeUndefined() // the kept record keeps its name
    const single = planMerge({ keep: person(20, { firstName: 'Madonna', lastName: '', firstNameLastName: 'Madonna' }), remove: person(500, { firstName: 'Madonna', lastName: '', firstNameLastName: 'Madonna' }) })
    expect(single.retirePatch.firstNameLastName).toBe('Madonna (archived)')
    expect(single.retirePatch.lastName).toBeUndefined()
  })

  it('does not merge a record that is archived already', () => {
    const archived = person(500, { lastName: 'Maasikas (archived)', firstNameLastName: 'Mari Maasikas (archived)' })
    const result = planMerge({ keep: OLD, remove: archived })
    expect(result.ok).toBe(false)
    expect(result.reason).toMatch(/already archived/)
    expect(planMerge({ keep: archived, remove: OLD }).reason).toMatch(/already archived/)
  })
})

// An in-memory Strapi that applies what it is told, so a merge can be followed from start to end
function fakeStrapi (people, { users = { 70: { id: 70, person: 500 } }, failOn = null, credits = [], ignoreCreditWrites = false, keepStaleLinks = false } = {}) {
  const store = new Map(people.map(p => [p.id, clone(p)]))
  const entries = new Map(credits.map(({ source, entry }) => [`${source}:${entry.id}`, clone(entry)]))
  const calls = []
  const idOf = v => (v && typeof v === 'object' ? v.id : v)
  const apply = (target, payload) => {
    for (const [key, value] of Object.entries(payload)) {
      if (key === 'skipbuild' || key === 'cgFormSave') continue
      if (Array.isArray(value) && value.every(v => typeof v === 'number')) target[key] = value.map(id => ({ id }))
      else if (typeof value === 'number' && ['picture', 'gender'].includes(key)) target[key] = { id: value }
      else target[key] = value
    }
  }
  return {
    calls,
    store,
    users,
    findPersonById (id) { return store.has(Number(id)) ? clone(store.get(Number(id))) : null },
    updatePerson (id, payload) {
      calls.push(['updatePerson', Number(id), payload])
      if (failOn === `updatePerson:${id}`) throw new Error('HTTP 500')
      const target = store.get(Number(id))
      const previousUser = idOf(target.user)
      apply(target, payload)
      if ('user' in payload) {
        // Strapi keeps the link on both sides: clearing it from the person side also clears user.person
        if (!keepStaleLinks && previousUser && users[previousUser] && Number(users[previousUser].person) === Number(id)) users[previousUser].person = null
        if (payload.user) { users[payload.user] = { ...(users[payload.user] || { id: payload.user }), person: Number(id) }; target.user = { id: payload.user } } else target.user = null
      }
    },
    linkPersonToUser (personId, userId) {
      calls.push(['linkPersonToUser', Number(personId), Number(userId)])
      users[userId] = { ...(users[userId] || { id: userId }), person: Number(personId) }
      store.get(Number(personId)).user = { id: userId }
    },
    getUser (id) { return users[id] ? clone(users[id]) : null },
    setUserFields (userId, fields) {
      calls.push(['setUserFields', Number(userId), fields])
      const user = users[userId]
      if ('user_roles' in fields) user.user_roles = fields.user_roles.map(id => ({ id }))
      if ('organisation' in fields) {
        for (const other of Object.values(users)) if (other !== user && idOf(other.organisation) === fields.organisation) other.organisation = null // one-to-one: it leaves the other login
        user.organisation = { id: fields.organisation }
      }
      if ('business_profiles' in fields) {
        for (const other of Object.values(users)) if (other !== user) other.business_profiles = (other.business_profiles || []).filter(profile => !fields.business_profiles.includes(profile.id))
        user.business_profiles = fields.business_profiles.map(id => ({ id }))
      }
    },
    clearUserPerson (userId) {
      calls.push(['clearUserPerson', Number(userId)])
      users[userId].person = null
    },
    setAliasUsers (mainId, aliasIds) {
      calls.push(['setAliasUsers', Number(mainId), aliasIds])
      users[mainId].aliasUsers = aliasIds.map(id => ({ id }))
      for (const id of aliasIds) users[id].mainUser = { id: Number(mainId) }
    },
    moveAddressToPerson (addressId, personId) {
      calls.push(['moveAddressToPerson', addressId, personId])
      for (const p of store.values()) if (idOf(p.addr_coll) === addressId) p.addr_coll = null
      store.get(Number(personId)).addr_coll = { id: addressId, country: { id: 7 } }
    },
    setAddressCountry (addressId, countryId) { calls.push(['setAddressCountry', addressId, countryId]) },
    deletePerson (id) { calls.push(['deletePerson', Number(id)]); store.delete(Number(id)) },
    findPersonReferences (ids) { calls.push(['findPersonReferences', ids]); return { refs: {}, covered: ['film'], failed: [] } },
    // entries that name a person (films, ...), keyed "source:id"
    entries,
    getCreditEntry (source, id) { return entries.has(`${source}:${id}`) ? clone(entries.get(`${source}:${id}`)) : null },
    updateCreditEntry (source, id, payload) {
      calls.push(['updateCreditEntry', `${source}:${id}`, payload])
      if (failOn === `updateCreditEntry:${source}:${id}`) throw new Error('HTTP 500')
      if (!ignoreCreditWrites) applyPatch(entries.get(`${source}:${id}`), payload)
    }
  }
}

// what Strapi does with a patch of component rows: rows with an id are updated in place, rows left out are deleted
function applyPatch (target, patch) {
  for (const [key, value] of Object.entries(patch)) {
    if (key === 'skipbuild' || key === 'cgFormSave') continue
    if (Array.isArray(value) && value.length && value.every(row => row && typeof row === 'object')) {
      target[key] = value.map((row) => { const have = (target[key] || []).find(item => item.id === row.id) || { id: row.id }; applyPatch(have, row); return have })
    } else if (Array.isArray(value)) target[key] = value.map(item => (typeof item === 'number' ? { id: item } : item))
    else if (value && typeof value === 'object') { target[key] ||= { id: value.id }; applyPatch(target[key], value) } else if (typeof value === 'number' && ['person', 'person_of_role', 'client_person'].includes(key)) target[key] = { id: value }
    else target[key] = value
  }
}

describe('mergePersons', () => {
  const people = () => [clone(OLD), clone(COPY)]

  it('a dry run plans the merge and writes nothing', async () => {
    const strapi = fakeStrapi(people())

    const result = await mergePersons({ keepId: 20, removeId: 500, strapi, dryRun: true, retire: 'hide', log: silent })

    expect(result.status).toBe('dry-run')
    expect(result.changes).toContain('eMail')
    expect(strapi.calls.filter(([name]) => name !== 'findPersonReferences')).toEqual([])
  })

  it('writes the kept record first, then the login user and address, then retires the other record; every save is silent and builds nothing', async () => {
    const strapi = fakeStrapi(people())

    const result = await mergePersons({ keepId: 20, removeId: 500, strapi, dryRun: false, retire: 'hide', log: silent })

    expect(result.status).toBe('merged')
    expect(strapi.calls.map(([name, id]) => `${name}:${id}`)).toEqual(['updatePerson:20', 'moveAddressToPerson:40', 'updatePerson:500', 'updatePerson:20'])
    expect(strapi.calls.some(([name]) => name === 'linkPersonToUser')).toBe(false) // PUT /users/:id would send the Creative Gate mail (users-permissions User.js afterUpdate)
    const [, , linkBody] = strapi.calls[3]
    expect(linkBody).toEqual({ user: 70, cgFormSave: true, skipbuild: true })
    const [, , keepBody] = strapi.calls[0]
    expect(keepBody).toMatchObject({ fiona_person_id: 'f-1', eMail: 'mari@acme.ee', organisations: [1, 2], cgFormSave: true, skipbuild: true })
    expect('user' in keepBody).toBe(false)
    const retireBody = strapi.calls.find(([name, id]) => name === 'updatePerson' && id === 500)[2]
    expect(retireBody).toMatchObject({ fiona_person_id: null, eMail: null, public: false, firstNameLastName: 'Mari Maasikas (archived)', cgFormSave: true, skipbuild: true })
    expect(strapi.store.get(20).fiona_person_id).toBe('f-1')
    expect(strapi.store.get(500).fiona_person_id).toBeNull()
    expect(strapi.users[70].person).toBe(20)
    expect(result.verify).toEqual({ ok: true, problems: [] })
  })

  it('works on a runtime without structuredClone (the hunt app has none): the backup is taken another way', async () => {
    const strapi = fakeStrapi(people())
    vi.stubGlobal('structuredClone', undefined)
    try {
      const result = await mergePersons({ keepId: 20, removeId: 500, strapi, dryRun: false, retire: 'hide', log: silent })

      expect(result.status).toBe('merged')
      expect(result.backup.remove).toMatchObject({ id: 500, eMail: 'mari@acme.ee' })
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('returns both records as they were, before any write', async () => {
    const strapi = fakeStrapi(people())

    const result = await mergePersons({ keepId: 20, removeId: 500, strapi, dryRun: false, retire: 'hide', log: silent })

    expect(result.backup.keep).toMatchObject({ id: 20, eMail: null, fiona_person_id: null })
    expect(result.backup.remove).toMatchObject({ id: 500, eMail: 'mari@acme.ee', fiona_person_id: 'f-1' })
  })

  it('frees a unique slug on the other record before the kept record takes it', async () => {
    const strapi = fakeStrapi([person(20, { slug_et: null, slug_en: null, slug_ru: null }), clone(COPY)])

    await mergePersons({ keepId: 20, removeId: 500, strapi, dryRun: false, retire: 'hide', log: silent })

    const updates = strapi.calls.filter(([name]) => name === 'updatePerson')
    expect(updates[0].slice(1)).toEqual([500, expect.objectContaining({ slug_et: null, slug_en: null, slug_ru: null })])
    expect(updates[1].slice(1)).toEqual([20, expect.objectContaining({ slug_en: 'mari-maasikas-1' })])
  })

  it('deletes the retired record instead of hiding it when asked', async () => {
    const strapi = fakeStrapi(people())

    const result = await mergePersons({ keepId: 20, removeId: 500, strapi, dryRun: false, retire: 'delete', log: silent })

    expect(result.status).toBe('merged')
    expect(strapi.calls.some(([name, id]) => name === 'deletePerson' && id === 500)).toBe(true)
    expect(strapi.store.has(500)).toBe(false)
    expect(result.verify.ok).toBe(true)
  })

  it('skips a pair that is not safe, with the reason, and writes nothing', async () => {
    const strapi = fakeStrapi(people())

    const result = await mergePersons({ keepId: 20, removeId: 500, strapi, dryRun: false, retire: 'hide', removeRefs: [{ source: 'team', id: 16 }], log: silent })

    expect(result.status).toBe('skipped')
    expect(result.reason).toMatch(/used in team #16/)
    expect(strapi.calls).toEqual([])
  })

  it('says so when a record does not exist (any more)', async () => {
    const strapi = fakeStrapi([clone(OLD)])

    const result = await mergePersons({ keepId: 20, removeId: 500, strapi, dryRun: false, retire: 'hide', log: silent })

    expect(result.status).toBe('skipped')
    expect(result.reason).toMatch(/#500 does not exist/)
  })

  it('ends with the login user on the kept record although hiding the other record took it off the user', async () => {
    const strapi = fakeStrapi(people())

    const result = await mergePersons({ keepId: 20, removeId: 500, strapi, dryRun: false, retire: 'hide', log: silent })

    expect(result.verify).toEqual({ ok: true, problems: [] })
    expect(strapi.users[70].person).toBe(20)
    expect(strapi.store.get(500).user).toBeNull()
  })

  it('links the login user again from the person side when the link was lost, and never through the user record', async () => {
    const strapi = fakeStrapi(people())
    const original = strapi.updatePerson
    let lost = false
    strapi.updatePerson = (id, payload) => {
      original(id, payload)
      if (Number(id) === 20 && payload.user && !lost) { lost = true; strapi.users[70].person = null }
    }

    const result = await mergePersons({ keepId: 20, removeId: 500, strapi, dryRun: false, retire: 'hide', log: silent })

    expect(result.verify.ok).toBe(true)
    expect(strapi.users[70].person).toBe(20)
    expect(strapi.calls.filter(([name, id, body]) => name === 'updatePerson' && id === 20 && body.user === 70)).toHaveLength(2)
    expect(strapi.calls.some(([name]) => name === 'linkPersonToUser')).toBe(false)
  })

  it('reports a failed check instead of calling the merge a success', async () => {
    const strapi = fakeStrapi(people())
    const original = strapi.updatePerson
    strapi.updatePerson = async (id, payload) => { if (Number(id) === 20) delete payload.fiona_person_id; await original(id, payload) }

    const result = await mergePersons({ keepId: 20, removeId: 500, strapi, dryRun: false, retire: 'hide', log: silent })

    expect(result.status).toBe('check-failed')
    expect(result.verify.problems.join(' ')).toMatch(/fiona_person_id/)
  })
})

describe('mergePersons: a person that is credited elsewhere (repointCredits)', () => {
  const people = () => [clone(OLD), clone(COPY)]
  const filmEntry = () => ({
    id: 9213,
    title_en: 'A film',
    credentials: { id: 77, rolePerson: [{ id: 11, order: 1, person: { id: 99 } }, { id: 12, order: 2, person: { id: 500 } }], roleCompany: [{ id: 301 }] }
  })
  const refs = [{ source: 'film', id: 9213 }]
  const run = (strapi, over = {}) => mergePersons({ keepId: 20, removeId: 500, strapi, dryRun: false, retire: 'hide', removeRefs: refs, repointCredits: true, log: silent, ...over })

  it('is not done unless asked: a record that is credited stays a reason to skip', async () => {
    const strapi = fakeStrapi(people(), { credits: [{ source: 'film', entry: filmEntry() }] })

    const result = await run(strapi, { repointCredits: false })

    expect(result).toMatchObject({ status: 'skipped' })
    expect(result.reason).toMatch(/used in film #9213/)
    expect(strapi.calls.filter(([name]) => name !== 'findPersonReferences')).toEqual([])
  })

  it('a dry run says what would be pointed over and writes nothing', async () => {
    const strapi = fakeStrapi(people(), { credits: [{ source: 'film', entry: filmEntry() }] })

    const result = await run(strapi, { dryRun: true })

    expect(result.status).toBe('dry-run')
    expect(result.credits).toEqual([{ source: 'film', id: 9213, changes: ['credentials.rolePerson #12: person 500 → 20'], dropped: 0 }])
    expect(strapi.calls.filter(([name]) => name !== 'findPersonReferences')).toEqual([])
  })

  it('points the credits over first (silently), checks them, and only then merges the persons', async () => {
    const strapi = fakeStrapi(people(), { credits: [{ source: 'film', entry: filmEntry() }] })

    const result = await run(strapi)

    expect(result.status).toBe('merged')
    expect(strapi.calls.map(([name, id]) => `${name}:${id}`)).toEqual(['updateCreditEntry:film:9213', 'updatePerson:20', 'moveAddressToPerson:40', 'updatePerson:500', 'updatePerson:20'])
    expect(strapi.calls[0][2]).toEqual({ credentials: { id: 77, rolePerson: [{ id: 11 }, { id: 12, person: 20 }] }, skipbuild: true })
    expect(strapi.entries.get('film:9213').credentials.rolePerson.map(row => row.person.id)).toEqual([99, 20])
    expect(result.credits).toEqual([{ source: 'film', id: 9213, changes: ['credentials.rolePerson #12: person 500 → 20'], dropped: 0 }])
  })

  it('returns the credits as they were before the write, to put back by hand', async () => {
    const strapi = fakeStrapi(people(), { credits: [{ source: 'film', entry: filmEntry() }] })

    const result = await run(strapi)

    expect(result.backup.credits).toEqual([{ source: 'film', id: 9213, before: { credentials: filmEntry().credentials } }])
  })

  it('leaves the persons alone and says so when a credit cannot be written', async () => {
    const strapi = fakeStrapi(people(), { credits: [{ source: 'film', entry: filmEntry() }], failOn: 'updateCreditEntry:film:9213' })

    const result = await run(strapi)

    expect(result).toMatchObject({ status: 'failed', error: 'HTTP 500' })
    expect(strapi.calls.some(([name]) => name === 'updatePerson')).toBe(false)
  })

  it('leaves the persons alone when the credit still names the old person after the write', async () => {
    const strapi = fakeStrapi(people(), { credits: [{ source: 'film', entry: filmEntry() }], ignoreCreditWrites: true })

    const result = await run(strapi)

    expect(result.status).toBe('check-failed')
    expect(result.verify.problems.join(' ')).toMatch(/film #9213/)
    expect(strapi.calls.some(([name]) => name === 'updatePerson')).toBe(false)
  })

  it('skips the pair, writing nothing, when the person is used where credits are not moved (a festival pass)', async () => {
    const strapi = fakeStrapi(people(), { credits: [{ source: 'film', entry: filmEntry() }] })

    const result = await run(strapi, { removeRefs: [...refs, { source: 'festival-pass', id: 5 }] })

    expect(result.status).toBe('skipped')
    expect(result.reason).toMatch(/festival-pass #5/)
    expect(strapi.calls.filter(([name]) => name !== 'findPersonReferences')).toEqual([])
  })

  it('skips the pair, writing nothing, when the scan names an entry that does not hold the person where it was expected', async () => {
    const entry = filmEntry()
    entry.credentials.rolePerson[1].person = { id: 98 }
    const strapi = fakeStrapi(people(), { credits: [{ source: 'film', entry }] })

    const result = await run(strapi)

    expect(result.status).toBe('skipped')
    expect(result.reason).toMatch(/film #9213/)
    expect(strapi.calls.filter(([name]) => name !== 'findPersonReferences')).toEqual([])
  })

  it('skips the pair when an entry it was told about is gone', async () => {
    const strapi = fakeStrapi(people())

    const result = await run(strapi)

    expect(result.status).toBe('skipped')
    expect(result.reason).toMatch(/film #9213/)
  })

  it('drops the duplicate row when the other person is credited in the same list already', async () => {
    const entry = filmEntry()
    entry.credentials.rolePerson[0].person = { id: 20 }
    entry.credentials.rolePerson[0].role_at_film = entry.credentials.rolePerson[1].role_at_film = { id: 3 }
    const strapi = fakeStrapi(people(), { credits: [{ source: 'film', entry }] })

    const result = await run(strapi)

    expect(result.status).toBe('merged')
    expect(strapi.entries.get('film:9213').credentials.rolePerson.map(row => row.id)).toEqual([11])
    expect(result.credits[0].dropped).toBe(1)
  })
})

describe('mergePersons: two logins, Fiona names the main one (aliasLogins)', () => {
  // the old record is logged in as #71, the sync-made copy as #70; Fiona knows #70
  const people = () => [clone({ ...OLD, user: { id: 71 } }), clone(COPY)]
  const logins = () => ({
    70: { id: 70, email: 'mari@acme.ee', person: 500, aliasUsers: [], mainUser: null, my_products: [], transactions: [], business_profiles: [], organisation: null, moodle_id: null, order: null, user_roles: [{ id: 1 }] },
    71: { id: 71, email: 'mari@old.ee', person: 20, aliasUsers: [], mainUser: null, my_products: [], transactions: [], business_profiles: [], organisation: null, moodle_id: null, order: null, user_roles: [{ id: 1 }] }
  })
  const run = (strapi, over = {}) => mergePersons({ keepId: 20, removeId: 500, strapi, dryRun: false, retire: 'hide', aliasLogins: true, fionaLogin: () => 70, log: silent, ...over })
  const writes = strapi => strapi.calls.filter(([name]) => name !== 'findPersonReferences')

  it('is not done unless asked: two different logins stay a reason to skip', async () => {
    const strapi = fakeStrapi(people(), { users: logins() })

    const result = await run(strapi, { aliasLogins: false })

    expect(result.status).toBe('skipped')
    expect(result.reason).toMatch(/different login users/)
    expect(writes(strapi)).toEqual([])
  })

  it('a dry run names the main and the alias login and writes nothing', async () => {
    const strapi = fakeStrapi(people(), { users: logins() })

    const result = await run(strapi, { dryRun: true })

    expect(result.status).toBe('dry-run')
    expect(result.alias).toMatchObject({ main: 70, alias: 71, notes: [] })
    expect(result.link.userId).toBe(70)
    expect(writes(strapi)).toEqual([])
  })

  it("merges the persons on Fiona's login, and makes the other login an alias of it", async () => {
    const strapi = fakeStrapi(people(), { users: logins() })

    const result = await run(strapi)

    expect(result.status).toBe('merged')
    expect(strapi.calls.at(-2)).toEqual(['updatePerson', 20, { user: 70, cgFormSave: true, skipbuild: true }]) // linked last, from the person side
    expect(strapi.calls.at(-1)).toEqual(['setAliasUsers', 70, [71]])
    expect(strapi.users[71].mainUser).toEqual({ id: 70 })
    expect(strapi.users[70].person).toBe(20)
    expect(strapi.users[71].person).toBeNull() // an alias is a login identity only
    expect(strapi.calls.some(([name]) => name === 'linkPersonToUser')).toBe(false)
  })

  it("takes the other login as main when that is Fiona's", async () => {
    const strapi = fakeStrapi(people(), { users: logins() })

    const result = await run(strapi, { fionaLogin: () => 71 })

    expect(result.status).toBe('merged')
    expect(result.alias).toMatchObject({ main: 71, alias: 70 })
    expect(strapi.calls.at(-1)).toEqual(['setAliasUsers', 71, [70]])
    expect(strapi.users[70].mainUser).toEqual({ id: 71 })
  })

  it('keeps the aliases the main login has already', async () => {
    const users = logins()
    users[70].aliasUsers = [{ id: 90 }]
    users[90] = { id: 90, mainUser: { id: 70 } }
    const strapi = fakeStrapi(people(), { users })

    await run(strapi)

    expect(strapi.calls.at(-1)).toEqual(['setAliasUsers', 70, [90, 71]])
  })

  it("asks Fiona for the login of the Fiona person (the sync-managed record's id)", async () => {
    const strapi = fakeStrapi(people(), { users: logins() })
    const asked = []

    await run(strapi, { dryRun: true, fionaLogin: (id) => { asked.push(id); return 70 } })

    expect(asked).toEqual(['f-1'])
  })

  it.each([
    ['Fiona knows no login', () => null, /Fiona knows no login/],
    ["Fiona's login is neither of the two", () => 99, /neither #71 nor #70|#99/]
  ])('skips the pair, writing nothing, when %s', async (_name, fionaLogin, reason) => {
    const strapi = fakeStrapi(people(), { users: logins() })

    const result = await run(strapi, { fionaLogin })

    expect(result.status).toBe('skipped')
    expect(result.reason).toMatch(reason)
    expect(writes(strapi)).toEqual([])
  })

  it('skips the pair, and the batch carries on, when Fiona cannot say which login it knows (for example: no published accreditation)', async () => {
    const strapi = fakeStrapi(people(), { users: logins() })

    const result = await run(strapi, { fionaLogin: () => { throw new Error('person f-1 has no published accreditation') } })

    expect(result.status).toBe('skipped')
    expect(result.reason).toMatch(/Fiona/)
    expect(result.reason).toMatch(/no published accreditation/)
    expect(writes(strapi)).toEqual([])
  })

  it('skips the pair when neither record is synced from Fiona, because nothing then says which login is the main one', async () => {
    const strapi = fakeStrapi([clone({ ...OLD, user: { id: 71 } }), clone({ ...COPY, fiona_person_id: null })], { users: logins() })

    const result = await run(strapi)

    expect(result.status).toBe('skipped')
    expect(result.reason).toMatch(/Fiona/)
    expect(writes(strapi)).toEqual([])
  })

  it.each([
    ['products (passes, tickets)', { my_products: [{ id: 1 }] }, /product/],
    ['payments', { transactions: [{ id: 1 }, { id: 2 }] }, /payment/],
    ['a business profile', { business_profiles: [{ id: 3 }] }, /business profile/],
    ['an organisation', { organisation: { id: 4 } }, /organisation/],
    ['a Moodle account', { moodle_id: '123' }, /Moodle/],
    ['an order', { order: { id: 5 } }, /order/],
    ['roles the main login lacks', { user_roles: [{ id: 1 }, { id: 8, name: 'Publisher' }] }, /role/],
    ['aliases of its own', { aliasUsers: [{ id: 91 }] }, /alias/],
    ['a main login of its own (it is an alias already)', { mainUser: { id: 92 } }, /alias|main/]
  ])('skips the pair, writing nothing, when the login that would become the alias has %s', async (_name, extra, reason) => {
    const users = logins()
    Object.assign(users[71], extra)
    const strapi = fakeStrapi(people(), { users })

    const result = await run(strapi)

    expect(result.status).toBe('skipped')
    expect(result.reason).toMatch(/#71/)
    expect(result.reason).toMatch(reason)
    expect(writes(strapi)).toEqual([])
  })

  describe('mainUser: the pair names the main login itself', () => {
    it('takes the named login as the main one without asking Fiona (when Fiona cannot say)', async () => {
      const strapi = fakeStrapi(people(), { users: logins() })
      let asked = 0

      const result = await run(strapi, { mainUserId: 71, fionaLogin: () => { asked++; return null } })

      expect(result.status).toBe('merged')
      expect(asked).toBe(0)
      expect(result.alias).toMatchObject({ main: 71, alias: 70 })
      expect(strapi.calls.at(-2)).toEqual(['updatePerson', 20, { user: 71, cgFormSave: true, skipbuild: true }])
      expect(strapi.users[70].mainUser).toEqual({ id: 71 })
    })

    it("can name a third login (Fiona's) as the main one: both person logins become its aliases", async () => {
      const users = logins()
      users[72] = { id: 72, email: 'fiona@x.ee', person: null, aliasUsers: [], mainUser: null, my_products: [], transactions: [], business_profiles: [], organisation: null, moodle_id: null, order: null, user_roles: [{ id: 1 }] }
      const strapi = fakeStrapi(people(), { users })

      const dry = await run(strapi, { dryRun: true, mainUserId: 72 })
      expect(dry.status).toBe('dry-run')
      expect(dry.alias).toMatchObject({ main: 72, alias: 70, aliases: [70, 71] })
      expect(writes(strapi)).toEqual([])

      const result = await run(strapi, { mainUserId: 72 })
      expect(result.status).toBe('merged')
      expect(strapi.calls.at(-2)).toEqual(['updatePerson', 20, { user: 72, cgFormSave: true, skipbuild: true }])
      expect(strapi.calls.at(-1)).toEqual(['setAliasUsers', 72, [70, 71]])
      expect(strapi.users[72].person).toBe(20)
      expect(strapi.users[70].mainUser).toEqual({ id: 72 })
      expect(strapi.users[71].mainUser).toEqual({ id: 72 })
      expect(strapi.users[70].person).toBeNull()
      expect(strapi.users[71].person).toBeNull()
      expect(result.backup.users.aliases.map(user => user.id)).toEqual([70, 71])
    })

    it('refuses a third login that belongs to another person', async () => {
      const users = logins()
      users[72] = { id: 72, person: 999, aliasUsers: [], mainUser: null, user_roles: [] }
      const strapi = fakeStrapi(people(), { users })

      const result = await run(strapi, { mainUserId: 72 })

      expect(result.status).toBe('skipped')
      expect(result.reason).toMatch(/#72.*person #999/)
      expect(writes(strapi)).toEqual([])
    })

    it('refuses a main login that cannot be read', async () => {
      const strapi = fakeStrapi(people(), { users: logins() })

      const result = await run(strapi, { mainUserId: 999 })

      expect(result.status).toBe('skipped')
      expect(result.reason).toMatch(/#999/)
      expect(writes(strapi)).toEqual([])
    })

    it('still refuses a third login that only Fiona names: it has to be named in the pair', async () => {
      const strapi = fakeStrapi(people(), { users: logins() })

      const result = await run(strapi, { fionaLogin: () => 72 })

      expect(result.status).toBe('skipped')
      expect(result.reason).toMatch(/neither of them/)
    })

    it('adds up what both aliases own: roles of both go to the main login, but two organisations still block', async () => {
      const users = logins()
      users[72] = { id: 72, person: null, aliasUsers: [], mainUser: null, user_roles: [{ id: 1 }], organisation: null }
      users[70].user_roles = [{ id: 1 }, { id: 5, name: 'A' }]
      users[71].user_roles = [{ id: 1 }, { id: 6, name: 'B' }]
      const strapi = fakeStrapi(people(), { users })

      const result = await run(strapi, { mainUserId: 72, moveToMain: ['roles', 'organisation'] })
      expect(result.status).toBe('merged')
      expect(strapi.calls.find(([name]) => name === 'setUserFields')).toEqual(['setUserFields', 72, { user_roles: [1, 5, 6] }])

      const twoOrganisations = logins()
      twoOrganisations[72] = { id: 72, person: null, aliasUsers: [], mainUser: null, user_roles: [{ id: 1 }], organisation: null }
      twoOrganisations[70].organisation = { id: 8 }
      twoOrganisations[71].organisation = { id: 9 }
      const blocked = await run(fakeStrapi(people(), { users: twoOrganisations }), { mainUserId: 72, moveToMain: ['organisation'] })
      expect(blocked.status).toBe('skipped')
      expect(blocked.reason).toMatch(/organisation/)
    })
  })

  describe('moveToMain: roles, organisation and business profiles of the alias login go to the main login', () => {
    const asked = ['roles', 'organisation', 'businessProfiles']
    const withAlias = (extra) => { const users = logins(); Object.assign(users[71], extra); return users }

    it('adds the roles the main login lacks to the main login (the alias keeps its own) and says so in the dry run', async () => {
      const users = withAlias({ user_roles: [{ id: 1 }, { id: 8, name: 'Publisher' }] })
      const strapi = fakeStrapi(people(), { users })

      const dry = await run(strapi, { dryRun: true, moveToMain: asked })
      expect(dry.status).toBe('dry-run')
      expect(dry.alias.moves).toEqual({ roles: ['Publisher'] })
      expect(writes(strapi)).toEqual([])

      const result = await run(strapi, { moveToMain: asked })
      expect(result.status).toBe('merged')
      expect(strapi.calls.find(([name]) => name === 'setUserFields')).toEqual(['setUserFields', 70, { user_roles: [1, 8] }])
      expect(strapi.users[70].user_roles.map(role => role.id)).toEqual([1, 8])
      expect(strapi.users[71].user_roles.map(role => role.id)).toEqual([1, 8])
    })

    it("moves the alias login's organisation to the main login, which then holds it alone", async () => {
      const strapi = fakeStrapi(people(), { users: withAlias({ organisation: { id: 4 } }) })

      const result = await run(strapi, { moveToMain: asked })

      expect(result.status).toBe('merged')
      expect(strapi.calls.find(([name]) => name === 'setUserFields')).toEqual(['setUserFields', 70, { organisation: 4 }])
      expect(strapi.users[70].organisation).toEqual({ id: 4 })
      expect(strapi.users[71].organisation).toBeNull()
      expect(result.alias.moves).toEqual({ organisation: 4 })
    })

    it('adds the business profiles of the alias login to those of the main login', async () => {
      const users = withAlias({ business_profiles: [{ id: 3 }] })
      users[70].business_profiles = [{ id: 2 }]
      const strapi = fakeStrapi(people(), { users })

      const result = await run(strapi, { moveToMain: asked })

      expect(result.status).toBe('merged')
      expect(strapi.calls.find(([name]) => name === 'setUserFields')).toEqual(['setUserFields', 70, { business_profiles: [2, 3] }])
      expect(strapi.users[71].business_profiles).toEqual([])
    })

    it('moves everything in one user update, before the alias link, and never through the person (no mail)', async () => {
      const strapi = fakeStrapi(people(), { users: withAlias({ user_roles: [{ id: 1 }, { id: 8 }], organisation: { id: 4 }, business_profiles: [{ id: 3 }] }) })

      await run(strapi, { moveToMain: asked })

      const names = strapi.calls.map(([name]) => name)
      expect(names.filter(name => name === 'setUserFields')).toHaveLength(1)
      expect(strapi.calls.find(([name]) => name === 'setUserFields')[2]).toEqual({ user_roles: [1, 8], organisation: 4, business_profiles: [3] })
      expect(names.indexOf('setUserFields')).toBeLessThan(names.indexOf('setAliasUsers'))
      expect(names.indexOf('setUserFields')).toBeGreaterThan(names.lastIndexOf('updatePerson') - 1)
    })

    it('still refuses what was not asked to move', async () => {
      const strapi = fakeStrapi(people(), { users: withAlias({ organisation: { id: 4 }, user_roles: [{ id: 1 }, { id: 8 }] }) })

      const result = await run(strapi, { moveToMain: ['roles'] })

      expect(result.status).toBe('skipped')
      expect(result.reason).toMatch(/organisation/)
      expect(writes(strapi)).toEqual([])
    })

    it('refuses when both logins have an organisation: one cannot take the other', async () => {
      const users = withAlias({ organisation: { id: 4 } })
      users[70].organisation = { id: 5 }
      const strapi = fakeStrapi(people(), { users })

      const result = await run(strapi, { moveToMain: asked })

      expect(result.status).toBe('skipped')
      expect(result.reason).toMatch(/both.*organisation/)
      expect(writes(strapi)).toEqual([])
    })

    it('does not move what blocks for other reasons (products, payments, an order, Moodle)', async () => {
      const strapi = fakeStrapi(people(), { users: withAlias({ my_products: [{ id: 1 }], user_roles: [{ id: 1 }, { id: 8 }] }) })

      const result = await run(strapi, { moveToMain: asked })

      expect(result.status).toBe('skipped')
      expect(result.reason).toMatch(/product/)
      expect(writes(strapi)).toEqual([])
    })

    it('reports a failed check when a move did not stick', async () => {
      const strapi = fakeStrapi(people(), { users: withAlias({ user_roles: [{ id: 1 }, { id: 8 }] }) })
      strapi.setUserFields = () => {}

      const result = await run(strapi, { moveToMain: asked })

      expect(result.status).toBe('check-failed')
      expect(result.verify.problems.join(' ')).toMatch(/role/)
    })

    it('writes nothing to the logins when nothing needs to move', async () => {
      const strapi = fakeStrapi(people(), { users: logins() })

      await run(strapi, { moveToMain: asked })

      expect(strapi.calls.some(([name]) => name === 'setUserFields')).toBe(false)
    })
  })

  it('merges the pair when the other login is an alias of the main login already, and does not write the alias link again', async () => {
    const users = logins()
    users[70].aliasUsers = [{ id: 71 }]
    users[71].mainUser = { id: 70 }
    const strapi = fakeStrapi(people(), { users })

    const dry = await run(strapi, { dryRun: true })
    expect(dry.status).toBe('dry-run')
    expect(dry.alias).toMatchObject({ main: 70, alias: 71, alreadyAlias: true })

    const result = await run(strapi)
    expect(result.status).toBe('merged')
    expect(strapi.calls.some(([name]) => name === 'setAliasUsers')).toBe(false)
    expect(strapi.users[70].person).toBe(20)
    expect(strapi.users[71].person).toBeNull()
  })

  it('still skips when the other login is an alias of a different login', async () => {
    const users = logins()
    users[71].mainUser = { id: 99 }
    const strapi = fakeStrapi(people(), { users })

    const result = await run(strapi)

    expect(result.status).toBe('skipped')
    expect(result.reason).toMatch(/alias of #99 already/)
    expect(writes(strapi)).toEqual([])
  })

  it('also skips when the main login would itself be an alias', async () => {
    const users = logins()
    users[70].mainUser = { id: 92 }
    const strapi = fakeStrapi(people(), { users })

    const result = await run(strapi)

    expect(result.status).toBe('skipped')
    expect(writes(strapi)).toEqual([])
  })

  it('returns both logins as they were, before any write', async () => {
    const strapi = fakeStrapi(people(), { users: logins() })

    const result = await run(strapi)

    expect(result.backup.users).toEqual({ main: logins()[70], alias: logins()[71] })
  })

  it('takes the alias login off the person when Strapi left it there, because an alias is a login identity only', async () => {
    const strapi = fakeStrapi(people(), { users: logins(), keepStaleLinks: true })

    const result = await run(strapi)

    expect(result.status).toBe('merged')
    expect(strapi.calls.at(-1)).toEqual(['clearUserPerson', 71])
    expect(strapi.users[71].person).toBeNull()
    expect(strapi.users[70].person).toBe(20)
  })

  it('does not touch the alias login again when it is off the person already', async () => {
    const strapi = fakeStrapi(people(), { users: logins() })

    await run(strapi)

    expect(strapi.calls.some(([name]) => name === 'clearUserPerson')).toBe(false)
  })

  it('reports a failed check when the alias link did not stick', async () => {
    const strapi = fakeStrapi(people(), { users: logins() })
    strapi.setAliasUsers = () => {}

    const result = await run(strapi)

    expect(result.status).toBe('check-failed')
    expect(result.verify.problems.join(' ')).toMatch(/#71/)
  })
})

describe('mergeBatch', () => {
  const people = () => [
    clone(OLD),
    clone(COPY),
    person(21, { firstNameLastName: 'Jaan Tamm', firstName: 'Jaan', lastName: 'Tamm', phoneNr: '1' }),
    person(501, { firstNameLastName: 'Jaan Tamm', firstName: 'Jaan', lastName: 'Tamm', eMail: 'jaan@x.ee', fiona_person_id: 'f-2', updated_at: '2026-10-28T00:00:00.000Z' })
  ]

  it('reads the places that use the persons once for the whole batch, merges the pairs one by one, and counts the results', async () => {
    const strapi = fakeStrapi(people())
    strapi.findPersonReferences = (ids) => { strapi.calls.push(['findPersonReferences', ids]); return { refs: { 501: [{ source: 'film', id: 3 }] }, covered: ['film'], failed: [] } }

    const result = await mergeBatch({ pairs: [{ keep: 20, remove: 500 }, { keep: 21, remove: 501 }], strapi, dryRun: false, retire: 'hide', log: silent })

    expect(strapi.calls.filter(([name]) => name === 'findPersonReferences')).toEqual([['findPersonReferences', [500, 501]]])
    expect(result.results.map(r => r.status)).toEqual(['merged', 'skipped'])
    expect(result.counts).toEqual({ merged: 1, skipped: 1, 'dry-run': 0, 'check-failed': 0, failed: 0 })
    expect(result.stoppedAt).toBeNull()
  })

  it('refuses to run when a source of references could not be read, because "not used" would be a guess', async () => {
    const strapi = fakeStrapi(people())
    strapi.findPersonReferences = () => ({ refs: {}, covered: [], failed: [{ source: 'film', error: 'HTTP 403' }] })

    await expect(mergeBatch({ pairs: [{ keep: 20, remove: 500 }], strapi, dryRun: false, retire: 'hide', log: silent })).rejects.toThrow(/film/)
  })

  it('stops at the first error and says where', async () => {
    const strapi = fakeStrapi(people(), { failOn: 'updatePerson:20' })

    const result = await mergeBatch({ pairs: [{ keep: 20, remove: 500 }, { keep: 21, remove: 501 }], strapi, dryRun: false, retire: 'hide', log: silent })

    expect(result.results).toHaveLength(1)
    expect(result.results[0]).toMatchObject({ status: 'failed', error: 'HTTP 500' })
    expect(result.stoppedAt).toEqual({ keep: 20, remove: 500 })
  })

  it('points credits over for the whole batch when asked to, and leaves a credited pair to be skipped otherwise', async () => {
    const entry = { id: 3, credentials: { id: 5, rolePerson: [{ id: 1, person: { id: 501 } }] } }
    const references = () => ({ refs: { 501: [{ source: 'film', id: 3 }] }, covered: ['film'], failed: [] })
    const credited = () => {
      const strapi = fakeStrapi(people(), { credits: [{ source: 'film', entry }] })
      strapi.findPersonReferences = references
      return strapi
    }

    const without = await mergeBatch({ pairs: [{ keep: 21, remove: 501 }], strapi: credited(), dryRun: false, retire: 'hide', log: silent })
    expect(without.results[0].status).toBe('skipped')

    const strapi = credited()
    const withCredits = await mergeBatch({ pairs: [{ keep: 21, remove: 501 }], strapi, dryRun: false, retire: 'hide', repointCredits: true, log: silent })
    expect(withCredits.results[0]).toMatchObject({ status: 'merged', keep: 21, remove: 501 })
    expect(withCredits.repointCredits).toBe(true)
    expect(strapi.entries.get('film:3').credentials.rolePerson[0].person.id).toBe(21)
  })

  it('carries the main login named in a pair and the Eventival switch to every pair', async () => {
    const users = { 70: { id: 70, person: 500, aliasUsers: [], mainUser: null }, 71: { id: 71, person: 20, aliasUsers: [], mainUser: null } }
    const strapi = fakeStrapi([clone({ ...OLD, user: { id: 71 }, remoteId: '1' }), clone({ ...COPY, remoteId: '2' })], { users })

    const result = await mergeBatch({ pairs: [{ keep: 20, remove: 500, mainUser: 71 }], strapi, dryRun: true, retire: 'hide', aliasLogins: true, ignoreEventivalIds: true, fionaLogin: () => null, log: silent })

    expect(result.ignoreEventivalIds).toBe(true)
    expect(result.results[0]).toMatchObject({ status: 'dry-run', alias: { main: 71, alias: 70 } })
  })

  it('passes what may move to the main login to every pair', async () => {
    const users = { 70: { id: 70, person: 500, aliasUsers: [], mainUser: null, user_roles: [{ id: 1 }] }, 71: { id: 71, person: 20, aliasUsers: [], mainUser: null, user_roles: [{ id: 1 }, { id: 8, name: 'Publisher' }] } }
    const strapi = fakeStrapi([clone({ ...OLD, user: { id: 71 } }), clone(COPY)], { users })

    const result = await mergeBatch({ pairs: [{ keep: 20, remove: 500 }], strapi, dryRun: true, retire: 'hide', aliasLogins: true, moveToMain: ['roles'], fionaLogin: () => 70, log: silent })

    expect(result.moveToMain).toEqual(['roles'])
    expect(result.results[0]).toMatchObject({ status: 'dry-run', alias: { moves: { roles: ['Publisher'] } } })
  })

  it('passes the choice of main login to every pair, and says so in the result', async () => {
    const users = { 70: { id: 70, person: 500, aliasUsers: [], mainUser: null }, 71: { id: 71, person: 20, aliasUsers: [], mainUser: null } }
    const strapi = fakeStrapi([clone({ ...OLD, user: { id: 71 } }), clone(COPY)], { users })

    const result = await mergeBatch({ pairs: [{ keep: 20, remove: 500 }], strapi, dryRun: true, retire: 'hide', aliasLogins: true, fionaLogin: () => 70, log: silent })

    expect(result.aliasLogins).toBe(true)
    expect(result.results[0]).toMatchObject({ status: 'dry-run', alias: { main: 70, alias: 71 } })
  })

  it('takes at most 100 pairs per call and ignores a pair listed twice', async () => {
    const strapi = fakeStrapi(people())
    await expect(mergeBatch({ pairs: Array.from({ length: 101 }, (_, i) => ({ keep: i + 1, remove: i + 1000 })), strapi, dryRun: true, retire: 'hide', log: silent })).rejects.toThrow(/at most 100/)

    const result = await mergeBatch({ pairs: [{ keep: 20, remove: 500 }, { keep: 20, remove: 500 }], strapi, dryRun: true, retire: 'hide', log: silent })
    expect(result.results).toHaveLength(1)
  })
})
