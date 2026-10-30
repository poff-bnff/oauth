import { describe, it, expect } from 'vitest'
import { planMerge, mergePersons, mergeBatch } from '../server/utils/fiona/personMerge.js'

const silent = { info () {}, warn () {}, error () {} }

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
})

// An in-memory Strapi that applies what it is told, so a merge can be followed from start to end
function fakeStrapi (people, { users = { 70: { id: 70, person: 500 } }, failOn = null } = {}) {
  const store = new Map(people.map(p => [p.id, structuredClone(p)]))
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
    findPersonById (id) { return store.has(Number(id)) ? structuredClone(store.get(Number(id))) : null },
    updatePerson (id, payload) {
      calls.push(['updatePerson', Number(id), payload])
      if (failOn === `updatePerson:${id}`) throw new Error('HTTP 500')
      apply(store.get(Number(id)), payload)
    },
    linkPersonToUser (personId, userId) {
      calls.push(['linkPersonToUser', Number(personId), Number(userId)])
      users[userId] = { ...(users[userId] || { id: userId }), person: Number(personId) }
      store.get(Number(personId)).user = { id: userId }
    },
    getUser (id) { return users[id] ? { ...users[id] } : null },
    moveAddressToPerson (addressId, personId) {
      calls.push(['moveAddressToPerson', addressId, personId])
      for (const p of store.values()) if (idOf(p.addr_coll) === addressId) p.addr_coll = null
      store.get(Number(personId)).addr_coll = { id: addressId, country: { id: 7 } }
    },
    setAddressCountry (addressId, countryId) { calls.push(['setAddressCountry', addressId, countryId]) },
    deletePerson (id) { calls.push(['deletePerson', Number(id)]); store.delete(Number(id)) },
    findPersonReferences (ids) { calls.push(['findPersonReferences', ids]); return { refs: {}, covered: ['film'], failed: [] } }
  }
}

describe('mergePersons', () => {
  const people = () => [structuredClone(OLD), structuredClone(COPY)]

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
    expect(strapi.calls.map(([name, id]) => `${name}:${id}`)).toEqual(['updatePerson:20', 'linkPersonToUser:20', 'moveAddressToPerson:40', 'updatePerson:500'])
    const [, , keepBody] = strapi.calls[0]
    expect(keepBody).toMatchObject({ fiona_person_id: 'f-1', eMail: 'mari@acme.ee', organisations: [1, 2], cgFormSave: true, skipbuild: true })
    const retireBody = strapi.calls.find(([name, id]) => name === 'updatePerson' && id === 500)[2]
    expect(retireBody).toMatchObject({ fiona_person_id: null, eMail: null, public: false, cgFormSave: true, skipbuild: true })
    expect(strapi.store.get(20).fiona_person_id).toBe('f-1')
    expect(strapi.store.get(500).fiona_person_id).toBeNull()
    expect(strapi.users[70].person).toBe(20)
    expect(result.verify).toEqual({ ok: true, problems: [] })
  })

  it('returns both records as they were, before any write', async () => {
    const strapi = fakeStrapi(people())

    const result = await mergePersons({ keepId: 20, removeId: 500, strapi, dryRun: false, retire: 'hide', log: silent })

    expect(result.backup.keep).toMatchObject({ id: 20, eMail: null, fiona_person_id: null })
    expect(result.backup.remove).toMatchObject({ id: 500, eMail: 'mari@acme.ee', fiona_person_id: 'f-1' })
  })

  it('frees a unique slug on the other record before the kept record takes it', async () => {
    const strapi = fakeStrapi([person(20, { slug_et: null, slug_en: null, slug_ru: null }), structuredClone(COPY)])

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
    const strapi = fakeStrapi([structuredClone(OLD)])

    const result = await mergePersons({ keepId: 20, removeId: 500, strapi, dryRun: false, retire: 'hide', log: silent })

    expect(result.status).toBe('skipped')
    expect(result.reason).toMatch(/#500 does not exist/)
  })

  it('puts the login user back on the kept record when retiring the other one took it away', async () => {
    const strapi = fakeStrapi(people())
    const original = strapi.updatePerson
    strapi.updatePerson = async (id, payload) => {
      await original(id, payload)
      if (Number(id) === 500 && 'user' in payload) strapi.users[70].person = null
    }

    const result = await mergePersons({ keepId: 20, removeId: 500, strapi, dryRun: false, retire: 'hide', log: silent })

    expect(result.verify.ok).toBe(true)
    expect(strapi.users[70].person).toBe(20)
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

describe('mergeBatch', () => {
  const people = () => [
    structuredClone(OLD),
    structuredClone(COPY),
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

  it('takes at most 100 pairs per call and ignores a pair listed twice', async () => {
    const strapi = fakeStrapi(people())
    await expect(mergeBatch({ pairs: Array.from({ length: 101 }, (_, i) => ({ keep: i + 1, remove: i + 1000 })), strapi, dryRun: true, retire: 'hide', log: silent })).rejects.toThrow(/at most 100/)

    const result = await mergeBatch({ pairs: [{ keep: 20, remove: 500 }, { keep: 20, remove: 500 }], strapi, dryRun: true, retire: 'hide', log: silent })
    expect(result.results).toHaveLength(1)
  })
})
