import { describe, it, expect } from 'vitest'
import { mergeDesired, planRemovals } from '../server/utils/fiona/desiredState.js'

const GB_A = 'gb-a'
const GB_B = 'gb-b'

function evaluation (overrides = {}) {
  return { level: 1, editionIds: [], roleIds: [], matchedRuleIds: [], ...overrides }
}

describe('mergeDesired', () => {
  it('creates a desired entry for a new person', () => {
    const desired = new Map()
    mergeDesired(desired, 'p1', { guestbookId: GB_A, accreditationId: 'acc1', evaluation: evaluation() })
    const d = desired.get('p1')
    expect(d.level).toBe(1)
    expect([...d.guestbookIds]).toEqual([GB_A])
    expect([...d.accreditationIds]).toEqual(['acc1'])
    expect([...d.editionIds]).toEqual([])
  })

  it('keeps the highest level and unions editions, roles and guestbooks across accreditations', () => {
    const desired = new Map()
    mergeDesired(desired, 'p1', { guestbookId: GB_A, accreditationId: 'acc1', evaluation: evaluation({ level: 1 }) })
    mergeDesired(desired, 'p1', { guestbookId: GB_B, accreditationId: 'acc2', evaluation: evaluation({ level: 2, editionIds: [59], roleIds: [7] }) })
    mergeDesired(desired, 'p1', { guestbookId: GB_B, accreditationId: 'acc3', evaluation: evaluation({ level: 2, editionIds: [90, 59] }) })
    const d = desired.get('p1')
    expect(d.level).toBe(2)
    expect([...d.guestbookIds]).toEqual([GB_A, GB_B])
    expect([...d.accreditationIds]).toEqual(['acc1', 'acc2', 'acc3'])
    expect([...d.editionIds].sort()).toEqual([59, 90])
    expect([...d.roleIds]).toEqual([7])
  })

  it('ignores level-0 evaluations', () => {
    const desired = new Map()
    mergeDesired(desired, 'p1', { guestbookId: GB_A, accreditationId: 'acc1', evaluation: evaluation({ level: 0 }) })
    expect(desired.has('p1')).toBe(false)
  })
})

describe('planRemovals', () => {
  function managed (overrides = {}) {
    return {
      id: 100,
      fiona_person_id: 'p1',
      fiona_guestbook_ids: GB_A,
      fiona_attached_edition_ids: '59,90',
      fiona_assigned_role_ids: '7',
      festival_editions: [{ id: 59 }, { id: 90 }, { id: 5 }],
      ...overrides
    }
  }
  const scope = { scannedGuestbookIds: new Set([GB_A]), editionIdsInScope: new Set([59, 90]), roleIdsInScope: new Set([7]) }

  it('unpublishes a managed person who is no longer desired in a scanned guestbook', () => {
    const { actions, skipped } = planRemovals({ managedPeople: [managed()], desired: new Map(), ...scope })
    expect(skipped).toBe(false)
    expect(actions).toHaveLength(1)
    expect(actions[0]).toMatchObject({
      type: 'UNPUBLISH',
      personId: 100,
      detachEditionIds: [59, 90],
      removeRoleIds: [7],
      remainingEditionIds: [5]
    })
  })

  it('leaves a person alone whose guestbook was not scanned this run', () => {
    const { actions } = planRemovals({ managedPeople: [managed({ fiona_guestbook_ids: GB_B })], desired: new Map(), ...scope })
    expect(actions).toHaveLength(0)
  })

  it('only detaches editions the sync attached and that belong to rules in scope', () => {
    const person = managed({ fiona_attached_edition_ids: '59,77', festival_editions: [{ id: 59 }, { id: 77 }, { id: 5 }] })
    const { actions } = planRemovals({ managedPeople: [person], desired: new Map(), ...scope })
    expect(actions[0].detachEditionIds).toEqual([59])
    expect(actions[0].remainingEditionIds).toEqual([5, 77])
  })

  it('downgrades to level 1 without unpublishing when the person is still desired at level 1', () => {
    const desired = new Map([['p1', { level: 1, editionIds: new Set(), roleIds: new Set(), guestbookIds: new Set([GB_A]) }]])
    const { actions } = planRemovals({ managedPeople: [managed()], desired, ...scope })
    expect(actions).toHaveLength(1)
    expect(actions[0]).toMatchObject({ type: 'DOWNGRADE', detachEditionIds: [59, 90], removeRoleIds: [7] })
  })

  it('does nothing for a person whose desired editions and roles are unchanged', () => {
    const desired = new Map([['p1', { level: 2, editionIds: new Set([59, 90]), roleIds: new Set([7]), guestbookIds: new Set([GB_A]) }]])
    const { actions } = planRemovals({ managedPeople: [managed()], desired, ...scope })
    expect(actions).toHaveLength(0)
  })

  it('keeps a person vouched for by an unscanned guestbook and only trims the scanned one', () => {
    const person = managed({ fiona_guestbook_ids: `${GB_A},${GB_B}` })
    const { actions } = planRemovals({ managedPeople: [person], desired: new Map(), ...scope })
    expect(actions).toHaveLength(1)
    expect(actions[0].type).toBe('DOWNGRADE')
    expect(actions[0].remainingGuestbookIds).toEqual([GB_B])
  })

  it('skips persons whose accreditation fetch errored this run', () => {
    const { actions } = planRemovals({ managedPeople: [managed()], desired: new Map(), erroredPersonIds: new Set(['p1']), ...scope })
    expect(actions).toHaveLength(0)
  })

  it('skips the whole phase when no scanned guestbook has a mapped rule', () => {
    const { actions, skipped, reason } = planRemovals({ managedPeople: [managed()], desired: new Map(), ...scope, rulesMapped: false })
    expect(skipped).toBe(true)
    expect(actions).toHaveLength(0)
    expect(reason).toMatch(/no active rule/i)
  })

  it('refuses more unpublishes than the cap unless forced', () => {
    const people = [1, 2, 3].map(n => managed({ id: n, fiona_person_id: `p${n}` }))
    const capped = planRemovals({ managedPeople: people, desired: new Map(), ...scope, maxRemovals: 2 })
    expect(capped.skipped).toBe(true)
    expect(capped.reason).toMatch(/3 unpublish/)
    const forced = planRemovals({ managedPeople: people, desired: new Map(), ...scope, maxRemovals: 2, force: true })
    expect(forced.skipped).toBe(false)
    expect(forced.actions).toHaveLength(3)
  })

  it('never touches persons without a fiona_person_id', () => {
    const { actions } = planRemovals({ managedPeople: [managed({ fiona_person_id: null })], desired: new Map(), ...scope })
    expect(actions).toHaveLength(0)
  })
})
