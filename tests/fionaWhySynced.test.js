/**
 * whySyncedReport — read-only probe (mode `whySynced` with `accreditationIds`): for a Fiona accreditation, would the sync create a Strapi
 * person, and if not, why? It uses the sync's own logic: the badges of the accreditation (XAPI), the active rules (Strapi) and
 * evaluateBadges. Rule ids and names, badge names and statuses and yes/no answers only: no names, e-mails or contact details.
 */
import { describe, it, expect } from 'vitest'
import { whySyncedReport } from '../server/utils/fiona/whySynced.js'

const pro = 'Industry@Tallinn & Baltic Event / PRO'
const rawRule = (overrides = {}) => ({
  id: 11,
  name: 'Industry PRO',
  active: true,
  badge_type_name: pro,
  sync_statuses: 'Approved, Printed',
  full_profile_statuses: 'Printed',
  festival_editions: [{ id: 114 }],
  user_roles: [{ id: 11 }],
  ...overrides
})
const badge = (statusText, badgeName = pro) => ({ badgeId: 'b-1', badgeName, statusText })

function deps ({ rules = [rawRule()], badges = [badge('Approved')], personId = 'fp-1', people = [], failBadges = false } = {}) {
  return {
    xapi: {
      getAccreditationBadges: () => (failBadges ? Promise.reject(new Error('504')) : Promise.resolve(badges)),
      getAccreditation: () => Promise.resolve({ personId, guestbookId: 'gb-1' })
    },
    strapi: { loadRules: () => Promise.resolve(rules), findPeopleByFionaIds: () => Promise.resolve(people) }
  }
}

describe('whySyncedReport', () => {
  it('says the sync would create the person when a badge status is in the rule\'s sync statuses and no Strapi person exists yet', async () => {
    const { accreditations } = await whySyncedReport({ accreditationIds: ['acc-1'], ...deps() })

    expect(accreditations[0]).toMatchObject({
      accreditationId: 'acc-1',
      level: 1,
      matchedRuleIds: [11],
      strapiPerson: { exists: false },
      badges: [{ name: pro, status: 'Approved', rules: [{ id: 11, name: 'Industry PRO', syncStatuses: ['approved', 'printed'], fullStatuses: ['printed'], match: 'sync' }] }]
    })
    expect(accreditations[0].verdict).toMatch(/would be created/i)
  })

  it('says full profile (level 2) when the status is in the full-profile statuses', async () => {
    const { accreditations } = await whySyncedReport({ accreditationIds: ['acc-1'], ...deps({ badges: [badge('Printed')] }) })

    expect(accreditations[0]).toMatchObject({ level: 2, fullRuleIds: [11] })
  })

  it('names the status that is missing from the rule when the badge is right but its status is not allowed', async () => {
    const { accreditations } = await whySyncedReport({ accreditationIds: ['acc-1'], ...deps({ badges: [badge('Requested')] }) })

    expect(accreditations[0].level).toBe(0)
    expect(accreditations[0].badges[0].rules[0]).toMatchObject({ id: 11, match: 'none' })
    expect(accreditations[0].verdict).toContain('"Requested"')
    expect(accreditations[0].verdict).toContain('approved')
  })

  it('says there is no active rule for a badge no rule names, and ignores inactive rules', async () => {
    const other = await whySyncedReport({ accreditationIds: ['a'], ...deps({ badges: [badge('Approved', 'Some other badge')] }) })
    const inactive = await whySyncedReport({ accreditationIds: ['a'], ...deps({ rules: [rawRule({ active: false })] }) })

    expect(other.accreditations[0].verdict).toMatch(/no active rule/i)
    expect(inactive.accreditations[0].verdict).toMatch(/no active rule/i)
    expect(inactive.rulesActive).toBe(0)
  })

  it('says there are no badges at all when the accreditation has none', async () => {
    const { accreditations } = await whySyncedReport({ accreditationIds: ['a'], ...deps({ badges: [] }) })

    expect(accreditations[0].verdict).toMatch(/no badges/i)
  })

  it('reports an existing Strapi person (id and whether it is public) and says what to look at when a matching one is missing from the sync', async () => {
    const people = [{ id: 40001, public: true, fiona_person_id: 'fp-1' }]

    const exists = await whySyncedReport({ accreditationIds: ['a'], ...deps({ people }) })

    expect(exists.accreditations[0].strapiPerson).toEqual({ exists: true, id: 40001, public: true })
    expect(exists.accreditations[0].verdict).toMatch(/already has a Strapi person/i)
    expect(JSON.stringify(exists)).not.toContain('fiona_person_id')
  })

  it('says when the accreditation has no linked person, and when a read fails, without failing the others', async () => {
    const noPerson = await whySyncedReport({ accreditationIds: ['a'], ...deps({ personId: null }) })
    expect(noPerson.accreditations[0].verdict).toMatch(/no linked person/i)

    const failing = await whySyncedReport({ accreditationIds: ['a'], ...deps({ failBadges: true }) })
    expect(failing.accreditations[0]).toMatchObject({ accreditationId: 'a', error: '504' })
  })

  it('answers for at most five accreditations, each once', async () => {
    const { accreditations } = await whySyncedReport({ accreditationIds: ['1', '1', '2', '3', '4', '5', '6', '7'], ...deps() })

    expect(accreditations.map(item => item.accreditationId)).toEqual(['1', '2', '3', '4', '5'])
  })

  it('does not put any name, e-mail or Fiona person id in its answer', async () => {
    const text = JSON.stringify(await whySyncedReport({ accreditationIds: ['acc-1'], ...deps({ personId: 'fp-secret-1' }) }))

    expect(text).not.toContain('fp-secret-1')
  })
})
