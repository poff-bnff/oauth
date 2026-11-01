import { describe, it, expect } from 'vitest'
import { explainPersons } from '../server/utils/fiona/explainPerson.js'

const PRO = { id: 2, name: 'Industry Pro → full profile', active: true, badge_type_id: 'b-pro', badge_type_name: 'Industry@Tallinn & Baltic Event / PRO', sync_statuses: 'requested, approved, paid, printed', full_profile_statuses: 'approved, paid, printed', festival_editions: [{ id: 59 }, { id: 114 }], user_roles: [{ id: 11 }] }
const STUDENT = { id: 4, name: 'Student / Talent → full profile', active: true, badge_type_id: 'b-student', badge_type_name: 'Student / Talent', sync_statuses: 'requested, paid', full_profile_statuses: 'paid', festival_editions: [{ id: 59 }], user_roles: [] }
const NO_EDITION = { id: 7, name: 'Press → profile only', active: true, badge_type_id: 'b-press', badge_type_name: 'Press', sync_statuses: 'printed', full_profile_statuses: 'printed', festival_editions: [], user_roles: [] }

const person = (over = {}) => ({
  id: 40141,
  firstName: 'Emma',
  lastName: 'Grape',
  fiona_person_id: 'f-1',
  fiona_accreditation_id: 'acc-1',
  fiona_guestbook_ids: 'gb-1',
  fiona_attached_edition_ids: '59,114',
  fiona_assigned_role_ids: '11',
  fiona_synced_at: '2026-11-01T10:00:00.000Z',
  fiona_unpublished_at: null,
  festival_editions: [{ id: 59 }, { id: 114 }],
  user: { id: 32029 },
  public: true,
  created_at: '2026-10-31T10:00:00.000Z',
  updated_at: '2026-11-01T18:33:00.000Z',
  ...over
})

const badge = (name, id, status) => ({ badgeName: name, badgeId: id, statusText: status })

function fakes ({ people = [person()], rules = [PRO, STUDENT, NO_EDITION], badges = { 'acc-1': [badge('Industry@Tallinn & Baltic Event / PRO', 'b-pro', 'printed')] }, failBadges = [] } = {}) {
  const calls = []
  return {
    calls,
    strapi: {
      findPersonById: id => Promise.resolve(people.find(p => p.id === Number(id)) ?? null),
      loadRules: () => Promise.resolve(rules)
    },
    fiona: {
      getAccreditationBadges: (id) => {
        calls.push(id)
        return failBadges.includes(id) ? Promise.reject(new Error('HTTP 502')) : Promise.resolve(badges[id] ?? [])
      }
    }
  }
}

const explain = async (over = {}, ids = [40141]) => {
  const { strapi, fiona } = fakes(over)
  const result = await explainPersons({ personIds: ids, strapi, fiona, log: { warn () {}, info () {}, error () {} } })
  return result
}

describe('explainPersons: why does a person have or lack an edition', () => {
  it('says the person holds everything the rules give when they match at full profile', async () => {
    const { persons: [entry] } = await explain()

    expect(entry).toMatchObject({ personId: 40141, name: 'Emma Grape' })
    expect(entry.wants).toEqual({ level: 2, editionIds: [59, 114], roleIds: [11] })
    expect(entry.holds.editionIds).toEqual([59, 114])
    expect(entry.missingEditionIds).toEqual([])
    expect(entry.verdict).toMatch(/holds everything/i)
  })

  it('lists the badges with their status and the rules that match, per accreditation', async () => {
    const { persons: [entry] } = await explain()

    expect(entry.accreditations).toEqual([{
      id: 'acc-1',
      badges: [{
        name: 'Industry@Tallinn & Baltic Event / PRO',
        id: 'b-pro',
        status: 'printed',
        rules: [{ id: 2, name: 'Industry Pro → full profile', result: 'full profile', editionIds: [59, 114], roleIds: [11] }]
      }]
    }])
  })

  it('names the missing edition when the rules want one the person does not hold', async () => {
    const { persons: [entry] } = await explain({ people: [person({ festival_editions: [{ id: 59 }], fiona_attached_edition_ids: '59' })] })

    expect(entry.missingEditionIds).toEqual([114])
    expect(entry.verdict).toMatch(/missing.*114/i)
  })

  it('explains a person who matches at the basic level only: no editions or roles are given then, by design', async () => {
    const { persons: [entry] } = await explain({
      people: [person({ festival_editions: [], fiona_attached_edition_ids: '', fiona_assigned_role_ids: '' })],
      badges: { 'acc-1': [badge('Industry@Tallinn & Baltic Event / PRO', 'b-pro', 'requested')] }
    })

    expect(entry.wants).toEqual({ level: 1, editionIds: [], roleIds: [] })
    expect(entry.accreditations[0].badges[0].rules[0]).toMatchObject({ id: 2, result: 'basic only' })
    expect(entry.verdict).toMatch(/basic level/i)
    expect(entry.verdict).toMatch(/requested/)
    expect(entry.verdict).toMatch(/#2/)
  })

  it('says when the status is in none of the lists of the rules that know the badge', async () => {
    const { persons: [entry] } = await explain({ badges: { 'acc-1': [badge('Student / Talent', 'b-student', 'approved')] } })

    expect(entry.wants.level).toBe(0)
    expect(entry.accreditations[0].badges[0].rules[0]).toMatchObject({ id: 4, result: 'status not listed' })
    expect(entry.verdict).toMatch(/status.*approved.*none of the lists/i)
  })

  it('says when no active rule knows the badge', async () => {
    const { persons: [entry] } = await explain({ badges: { 'acc-1': [badge('Guest', 'b-guest', 'printed')] } })

    expect(entry.wants.level).toBe(0)
    expect(entry.accreditations[0].badges[0].rules).toEqual([])
    expect(entry.verdict).toMatch(/no active rule/i)
    expect(entry.verdict).toMatch(/Guest/)
  })

  it('says when the matching rules carry no festival edition', async () => {
    const { persons: [entry] } = await explain({ people: [person({ festival_editions: [] })], badges: { 'acc-1': [badge('Press', 'b-press', 'printed')] } })

    expect(entry.wants).toEqual({ level: 2, editionIds: [], roleIds: [] })
    expect(entry.verdict).toMatch(/no festival edition/i)
  })

  it('tells editions the sync attached from editions the person got another way', async () => {
    const { persons: [entry] } = await explain({
      people: [person({ festival_editions: [{ id: 59 }], fiona_attached_edition_ids: '' })],
      badges: { 'acc-1': [badge('Student / Talent', 'b-student', 'requested')] }
    })

    expect(entry.holds).toEqual({ editionIds: [59], attachedBySync: [], addedOtherwise: [59] })
    expect(entry.verdict).toMatch(/59.*not attached by the sync/i)
  })

  it('shows the state of the person in Strapi that matters for the sync', async () => {
    const { persons: [entry] } = await explain()

    expect(entry.sync).toEqual({
      fionaPersonId: 'f-1',
      accreditationIds: ['acc-1'],
      guestbookIds: ['gb-1'],
      attachedEditionIds: [59, 114],
      assignedRoleIds: [11],
      syncedAt: '2026-11-01T10:00:00.000Z',
      unpublishedAt: null,
      userId: 32029,
      public: true,
      createdAt: '2026-10-31T10:00:00.000Z',
      updatedAt: '2026-11-01T18:33:00.000Z'
    })
  })

  it('unions several accreditations the way the sync does (highest level, all editions)', async () => {
    const { persons: [entry] } = await explain({
      people: [person({ fiona_accreditation_id: 'acc-1,acc-2', festival_editions: [{ id: 59 }], fiona_attached_edition_ids: '59' })],
      badges: {
        'acc-1': [badge('Student / Talent', 'b-student', 'paid')],
        'acc-2': [badge('Industry@Tallinn & Baltic Event / PRO', 'b-pro', 'approved')]
      }
    })

    expect(entry.wants).toEqual({ level: 2, editionIds: [59, 114], roleIds: [11] })
    expect(entry.accreditations.map(a => a.id)).toEqual(['acc-1', 'acc-2'])
    expect(entry.missingEditionIds).toEqual([114])
  })

  it('reports a badge list that cannot be read instead of guessing', async () => {
    const { persons: [entry] } = await explain({ failBadges: ['acc-1'] })

    expect(entry.accreditations[0]).toMatchObject({ id: 'acc-1', error: expect.stringMatching(/502/) })
    expect(entry.verdict).toMatch(/could not be read/i)
  })

  it('skips a person that does not exist or is not managed by the sync', async () => {
    const { persons, skipped } = await explain({ people: [person({ id: 41, fiona_person_id: null })] }, [41, 999])

    expect(persons).toEqual([])
    expect(skipped).toEqual([{ personId: 41, reason: 'not managed by the Fiona sync' }, { personId: 999, reason: 'not found' }])
  })

  it('takes at most 10 persons and needs ids', async () => {
    await expect(explain({}, Array.from({ length: 11 }, (_, i) => i + 1))).rejects.toThrow(/at most 10/)
    await expect(explain({}, [])).rejects.toThrow(/personIds/)
  })

  it('reads nothing from Fiona for a person it skips', async () => {
    const { strapi, fiona, calls } = fakes({ people: [person({ id: 41, fiona_person_id: null })] })

    await explainPersons({ personIds: [41], strapi, fiona, log: console })

    expect(calls).toEqual([])
  })
})
