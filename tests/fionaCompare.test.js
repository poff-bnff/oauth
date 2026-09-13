import { describe, it, expect } from 'vitest'
import { compareSources } from '../server/utils/fiona/compare.js'

function client (accreditations) {
  // accreditations: { id: { badges: [{ badgeId, badgeName, statusText }] } }
  return {
    listAccreditations: () => Object.keys(accreditations).map(id => ({ id })),
    getAccreditationBadges: id => accreditations[id]?.badges || []
  }
}

describe('compareSources', () => {
  it('reports badge holders missing on either side and status differences per badge', async () => {
    const xapi = client({
      a1: { badges: [{ badgeId: 'pro', badgeName: 'PRO', statusText: 'Paid' }] },
      a2: { badges: [{ badgeId: 'pro', badgeName: 'PRO', statusText: 'Paid' }] },
      a3: { badges: [] },
      a4: { badges: [{ badgeId: 'guest', badgeName: 'Guest', statusText: 'Invoiced' }] }
    })
    const publication = client({
      a1: { badges: [{ badgeId: 'pro', badgeName: 'PRO', statusText: 'paid' }] },
      a2: { badges: [{ badgeId: 'pro', badgeName: 'PRO', statusText: 'Created' }] },
      a3: { badges: [] },
      a5: { badges: [{ badgeId: 'jury', badgeName: 'Jury', statusText: 'Approved' }] }
    })

    const result = await compareSources({ xapi, publication, guestbookIds: ['gb'] })

    const gb = result.guestbooks.gb
    expect(gb.xapiAccreditations).toBe(4)
    expect(gb.publicationAccreditations).toBe(4)
    expect(gb.xapiBadgeHolders).toBe(3)
    expect(gb.publicationBadgeHolders).toBe(3)
    expect(gb.onlyInXapi).toEqual([{ id: 'a4', badges: ['Guest: Invoiced'] }])
    expect(gb.onlyInPublication).toEqual([{ id: 'a5', badges: ['Jury: Approved'] }])
    expect(gb.statusDiffs).toEqual([{ id: 'a2', badge: 'PRO', xapi: 'paid', publication: 'created' }])
    expect(gb.identicalBadgeHolders).toBe(1)
  })

  it('counts a guestbook as failed when one side cannot be read', async () => {
    const xapi = { listAccreditations: () => { throw new Error('xapi down') }, getAccreditationBadges: () => [] }
    const publication = client({})
    const result = await compareSources({ xapi, publication, guestbookIds: ['gb'], log: { warn () {}, error () {} } })
    expect(result.guestbooks.gb.error).toMatch(/xapi down/)
  })
})
