import { describe, it, expect } from 'vitest'
import { parseStatusList, normalizeRules, indexRules, evaluateBadges } from '../server/utils/fiona/rules.js'

const GUID_TEAM = 'A1B2C3D4-0000-0000-0000-000000000123'
const GUID_PRO = 'a1b2c3d4-0000-0000-0000-000000000222'

function rawRule (overrides = {}) {
  return {
    id: 1,
    name: 'rule',
    badge_type_id: GUID_TEAM,
    badge_type_name: 'TEAM',
    sync_statuses: 'pending, created, approved',
    full_profile_statuses: '',
    festival_editions: [],
    user_roles: [],
    active: true,
    ...overrides
  }
}

describe('parseStatusList', () => {
  it('splits on commas, trims, lower-cases and drops empties', () => {
    expect([...parseStatusList('Approved, paid ,PRINTED,,')]).toEqual(['approved', 'paid', 'printed'])
  })

  it('returns an empty set for null, undefined or blank input', () => {
    expect(parseStatusList(null).size).toBe(0)
    expect(parseStatusList(undefined).size).toBe(0)
    expect(parseStatusList('   ').size).toBe(0)
  })
})

describe('normalizeRules', () => {
  it('lower-cases the badge id and name and parses both status lists', () => {
    const { rules } = normalizeRules([rawRule({ full_profile_statuses: 'approved' })])
    expect(rules).toHaveLength(1)
    expect(rules[0].badgeId).toBe(GUID_TEAM.toLowerCase())
    expect(rules[0].badgeName).toBe('team')
    expect([...rules[0].level1]).toEqual(['pending', 'created', 'approved'])
    expect([...rules[0].level2]).toEqual(['approved'])
  })

  it('keeps edition and role ids from populated relations', () => {
    const { rules } = normalizeRules([rawRule({
      festival_editions: [{ id: 59 }, { id: 90 }],
      user_roles: [{ id: 7 }]
    })])
    expect(rules[0].editionIds).toEqual([59, 90])
    expect(rules[0].roleIds).toEqual([7])
  })

  it('drops level-2 statuses that are not in level 1 and reports a warning', () => {
    const { rules, warnings } = normalizeRules([rawRule({
      sync_statuses: 'approved',
      full_profile_statuses: 'approved, paid'
    })])
    expect([...rules[0].level2]).toEqual(['approved'])
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toMatch(/paid/)
  })

  it('skips inactive rules and rules without a badge id or name', () => {
    const { rules, warnings } = normalizeRules([
      rawRule({ id: 1, active: false }),
      rawRule({ id: 2, badge_type_id: '', badge_type_name: '' }),
      rawRule({ id: 3 })
    ])
    expect(rules.map(r => r.id)).toEqual([3])
    expect(warnings).toHaveLength(1)
  })
})

describe('evaluateBadges', () => {
  const { rules } = normalizeRules([
    rawRule({ id: 1, badge_type_id: GUID_TEAM, badge_type_name: 'TEAM', sync_statuses: 'pending, created, approved' }),
    rawRule({
      id: 2,
      badge_type_id: GUID_PRO,
      badge_type_name: 'Industry PRO',
      sync_statuses: 'approved, paid',
      full_profile_statuses: 'approved, paid',
      festival_editions: [{ id: 59 }, { id: 90 }],
      user_roles: [{ id: 7 }]
    })
  ])
  const index = indexRules(rules)

  it('returns level 0 when no badge matches any rule', () => {
    const result = evaluateBadges([{ badgeId: 'nope', badgeName: 'Guest', statusText: 'Approved' }], index)
    expect(result.level).toBe(0)
    expect(result.editionIds).toEqual([])
    expect(result.roleIds).toEqual([])
  })

  it('returns level 1 without editions or roles for a level-1-only rule', () => {
    const result = evaluateBadges([{ badgeId: GUID_TEAM, badgeName: 'TEAM', statusText: 'Pending' }], index)
    expect(result.level).toBe(1)
    expect(result.editionIds).toEqual([])
    expect(result.roleIds).toEqual([])
    expect(result.matchedRuleIds).toEqual([1])
  })

  it('returns level 2 with the rule editions and roles when a level-2 status matches', () => {
    const result = evaluateBadges([{ badgeId: GUID_PRO, badgeName: 'Industry PRO', statusText: 'paid' }], index)
    expect(result.level).toBe(2)
    expect(result.editionIds).toEqual([59, 90])
    expect(result.roleIds).toEqual([7])
  })

  it('returns level 0 when the badge is known but its status is outside both lists', () => {
    const result = evaluateBadges([{ badgeId: GUID_PRO, badgeName: 'Industry PRO', statusText: 'Cancelled' }], index)
    expect(result.level).toBe(0)
  })

  it('matches the badge id case-insensitively', () => {
    const result = evaluateBadges([{ badgeId: GUID_TEAM.toLowerCase(), badgeName: 'x', statusText: 'CREATED' }], index)
    expect(result.level).toBe(1)
  })

  it('falls back to the badge name when the badge id is unknown', () => {
    const result = evaluateBadges([{ badgeId: 'other-guid', badgeName: 'industry pro', statusText: 'approved' }], index)
    expect(result.level).toBe(2)
  })

  it('takes the highest level and unions editions across several badges', () => {
    const { rules: two } = normalizeRules([
      rawRule({ id: 5, badge_type_id: 'g5', sync_statuses: 'ok', full_profile_statuses: 'ok', festival_editions: [{ id: 1 }] }),
      rawRule({ id: 6, badge_type_id: 'g6', sync_statuses: 'ok', full_profile_statuses: 'ok', festival_editions: [{ id: 2 }, { id: 1 }], user_roles: [{ id: 9 }] })
    ])
    const result = evaluateBadges([
      { badgeId: 'g5', badgeName: '', statusText: 'ok' },
      { badgeId: 'g6', badgeName: '', statusText: 'ok' },
      { badgeId: GUID_TEAM, badgeName: '', statusText: 'nope' }
    ], indexRules(two))
    expect(result.level).toBe(2)
    expect(result.editionIds).toEqual([1, 2])
    expect(result.roleIds).toEqual([9])
    expect(result.matchedRuleIds).toEqual([5, 6])
  })
})
