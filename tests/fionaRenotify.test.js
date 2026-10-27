import { describe, it, expect, beforeEach } from 'vitest'
import { renotifyPersons } from '../server/utils/fiona/renotify.js'

const CG = 59
const silent = { info () {}, warn () {}, error () {} }

function fakeStrapi () {
  const state = { people: new Map(), writes: [], attempts: 0, failWrite: null }
  const populated = p => ({ ...p, festival_editions: (p.festival_editions || []).map(id => ({ id })) })
  return {
    state,
    findPersonById: id => (state.people.has(Number(id)) ? populated(state.people.get(Number(id))) : null),
    updatePerson: (id, payload) => {
      state.attempts++
      if (state.failWrite && state.failWrite(state.attempts, payload)) throw new Error('Strapi down')
      state.writes.push({ id: Number(id), payload })
      Object.assign(state.people.get(Number(id)), payload)
    }
  }
}

const synced = (id, extra = {}) => ({ id, firstName: 'P', lastName: String(id), fiona_person_id: `fp-${id}`, festival_editions: [CG, 114], user: { id: id + 1000 }, ...extra })

describe('renotifyPersons', () => {
  let strapi
  beforeEach(() => { strapi = fakeStrapi() })

  it('is a dry run unless told otherwise: lists who would be notified and writes nothing', async () => {
    strapi.state.people.set(1, synced(1))

    const result = await renotifyPersons({ personIds: [1] }, { strapi, log: silent })

    expect(result.dryRun).toBe(true)
    expect(result.notify).toEqual([{ personId: 1, name: 'P 1', userId: 1001 }])
    expect(strapi.state.writes).toEqual([])
  })

  it('takes the Creative Gate edition off and puts it straight back, so Strapi sees the person become ready again', async () => {
    strapi.state.people.set(1, synced(1))

    const result = await renotifyPersons({ personIds: [1], dryRun: false }, { strapi, log: silent })

    expect(strapi.state.writes).toEqual([
      { id: 1, payload: { festival_editions: [114], skipbuild: true } },
      { id: 1, payload: { festival_editions: [CG, 114], skipbuild: true } }
    ])
    expect(result.done).toEqual([1])
    expect(result.errors).toEqual([])
  })

  it('skips persons the sync does not manage, without the edition, without a user, or unpublished by the sync', async () => {
    strapi.state.people.set(2, synced(2, { fiona_person_id: null }))
    strapi.state.people.set(3, synced(3, { festival_editions: [114] }))
    strapi.state.people.set(4, synced(4, { user: null }))
    strapi.state.people.set(5, synced(5, { fiona_unpublished_at: '2026-10-01T00:00:00.000Z' }))

    const result = await renotifyPersons({ personIds: [2, 3, 4, 5, 99], dryRun: false }, { strapi, log: silent })

    expect(result.skipped).toEqual([
      { personId: 2, reason: 'not managed by the Fiona sync' },
      { personId: 3, reason: 'does not hold the Creative Gate edition' },
      { personId: 4, reason: 'no linked user' },
      { personId: 5, reason: 'taken off Creative Gate by the sync' },
      { personId: 99, reason: 'not found' }
    ])
    expect(strapi.state.writes).toEqual([])
  })

  it('retries the second write once, so a hiccup does not leave a person off Creative Gate', async () => {
    strapi.state.people.set(1, synced(1))
    strapi.state.failWrite = n => n === 2 // the first attempt to restore fails, the retry works

    const result = await renotifyPersons({ personIds: [1], dryRun: false }, { strapi, log: silent })

    expect(result.done).toEqual([1])
    expect(strapi.state.people.get(1).festival_editions).toEqual([CG, 114])
  })

  it('says loudly which person was left without the edition when the restore keeps failing', async () => {
    strapi.state.people.set(1, synced(1))
    strapi.state.failWrite = n => n >= 2

    const result = await renotifyPersons({ personIds: [1], dryRun: false }, { strapi, log: silent })

    expect(result.done).toEqual([])
    expect(result.errors).toHaveLength(1)
    expect(result.errors[0]).toMatchObject({ personId: 1 })
    expect(result.errors[0].message).toMatch(/restore the Creative Gate edition/i)
  })

  it('handles each person once even when listed twice, and refuses more than 100', async () => {
    strapi.state.people.set(1, synced(1))
    const result = await renotifyPersons({ personIds: [1, 1, '1'], dryRun: false }, { strapi, log: silent })
    expect(result.done).toEqual([1])
    expect(strapi.state.writes).toHaveLength(2)
    await expect(renotifyPersons({ personIds: Array.from({ length: 101 }, (_, i) => i + 1) }, { strapi, log: silent })).rejects.toThrow(/at most 100/)
  })

  it('needs at least one person id', async () => {
    await expect(renotifyPersons({ personIds: [] }, { strapi, log: silent })).rejects.toThrow(/personIds/)
  })
})
