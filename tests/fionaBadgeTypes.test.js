import { describe, it, expect } from 'vitest'
import { listBadgeTypes } from '../server/utils/fiona/badgeTypes.js'

const silent = { info () {}, warn () {}, error () {} }

function fakes () {
  const xapi = {
    listGuestbooks: () => [{ id: 'gb-30', name: 'PÖFF 30' }, { id: 'gb-29', name: 'PÖFF 29' }],
    listGuestbookBadges: (id) => {
      if (id === 'gb-bad') throw new Error('Fiona down')
      return id === 'gb-30'
        ? [{ id: 'b-jury', name: 'Jury' }, { id: 'b-guest', name: 'Guest' }, { id: 'b-pro', name: 'Industry PRO' }]
        : [{ id: 'b-old', name: 'Old badge' }]
    }
  }
  const strapi = { getActiveGuestbookIds: () => ['gb-30'] }
  return { xapi, strapi }
}

describe('listBadgeTypes', () => {
  it('lists the badge types of the active guestbooks with their ids, by name, straight from the XAPI', async () => {
    const { xapi, strapi } = fakes()

    const result = await listBadgeTypes({ xapi, strapi, log: silent })

    expect(result.guestbooks).toEqual([{
      id: 'gb-30',
      name: 'PÖFF 30',
      badges: [{ id: 'b-guest', name: 'Guest' }, { id: 'b-pro', name: 'Industry PRO' }, { id: 'b-jury', name: 'Jury' }]
    }])
    expect(result.errors).toEqual([])
  })

  it('takes the guestbooks it is asked for instead of the active ones', async () => {
    const { xapi, strapi } = fakes()

    const result = await listBadgeTypes({ guestbookIds: ['gb-29'], xapi, strapi, log: silent })

    expect(result.guestbooks.map(g => [g.id, g.name, g.badges.length])).toEqual([['gb-29', 'PÖFF 29', 1]])
  })

  it('reports a guestbook that Fiona fails on and carries on with the others', async () => {
    const { xapi, strapi } = fakes()

    const result = await listBadgeTypes({ guestbookIds: ['gb-bad', 'gb-30'], xapi, strapi, log: silent })

    expect(result.guestbooks.map(g => g.id)).toEqual(['gb-30'])
    expect(result.errors).toEqual([{ guestbookId: 'gb-bad', message: 'Fiona down' }])
  })

  it('names a guestbook the key does not list as unknown rather than failing', async () => {
    const { xapi, strapi } = fakes()
    xapi.listGuestbookBadges = () => [{ id: 'x', name: 'X' }]

    const result = await listBadgeTypes({ guestbookIds: ['gb-unlisted'], xapi, strapi, log: silent })

    expect(result.guestbooks).toEqual([{ id: 'gb-unlisted', name: null, badges: [{ id: 'x', name: 'X' }] }])
  })
})
