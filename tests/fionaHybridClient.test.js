import { describe, it, expect } from 'vitest'
import { createHybridClient } from '../server/utils/fiona/hybridClient.js'

function calls () {
  const log = []
  const record = name => (...args) => { log.push([name, ...args]) }
  return { log, record }
}

function publicationStub (overrides = {}) {
  return {
    listGuestbooks: () => [{ id: 'gb', name: 'GB' }],
    listGuestbookBadges: () => [{ id: 'b', name: 'B' }],
    listAccreditations: () => [{ id: 'acc' }],
    getAccreditationBadges: () => [{ badgeId: 'b', badgeName: 'B', statusText: 'Paid' }],
    getAccreditation: () => ({ personId: 'p', guestbookId: 'gb', noPublicationOfContactDetails: false, films: [] }),
    getPerson: () => ({ id: 'p', firstName: 'A', lastName: 'B', email: 'a@b.ee', phone: null, bio: null, country: null, externalAccountId: '5', photoToken: 'tok' }),
    getMyPoffUserId: () => '5',
    getPersonPhoto: () => ({ buffer: Buffer.from('pub'), filename: 'x.jpg' }),
    listMutations: () => [{ entityName: 'Person', entityId: 'p', mutation: 1 }],
    getAccreditationBadgeRecord: () => ({ accreditationId: 'acc' }),
    getPersonAccreditations: () => [{ id: 'acc', guestbookId: 'gb' }],
    ...overrides
  }
}

function xapiStub (tracker, overrides = {}) {
  return {
    getPerson: (...a) => { tracker.record('xapi.getPerson')(...a); return { firstName: 'A', lastName: 'B', email: 'x@api.ee', phone: '+1', bio: 'bio', country: null } },
    getMyPoffUserId: (...a) => { tracker.record('xapi.getMyPoffUserId')(...a); return '99' },
    getPersonPhoto: (...a) => { tracker.record('xapi.getPersonPhoto')(...a); return { buffer: Buffer.from('xapi'), filename: 'y.jpg' } },
    ...overrides
  }
}

describe('createHybridClient', () => {
  it('passes list and lookup calls straight to the Publication client', async () => {
    const client = createHybridClient({ publication: publicationStub(), xapi: xapiStub(calls()), log: { warn () {} } })
    expect(await client.listGuestbooks()).toEqual([{ id: 'gb', name: 'GB' }])
    expect(await client.listAccreditations('gb')).toEqual([{ id: 'acc' }])
    expect(await client.getAccreditationBadges('acc')).toHaveLength(1)
    expect(await client.getAccreditation('acc')).toMatchObject({ personId: 'p' })
    expect(await client.listMutations('2026-09-01')).toHaveLength(1)
    expect(await client.getAccreditationBadgeRecord('b')).toEqual({ accreditationId: 'acc' })
    expect(await client.getPersonAccreditations('p')).toEqual([{ id: 'acc', guestbookId: 'gb' }])
  })

  it('does not touch the XAPI when the published person already has an email, a MyPoff link and a photo', async () => {
    const tracker = calls()
    const client = createHybridClient({ publication: publicationStub(), xapi: xapiStub(tracker), log: { warn () {} } })
    expect((await client.getPerson('p')).email).toBe('a@b.ee')
    expect(await client.getMyPoffUserId('p')).toBe('5')
    expect((await client.getPersonPhoto('p')).buffer.toString()).toBe('pub')
    expect(tracker.log).toEqual([])
  })

  it('fills a missing email and phone from the XAPI person, keeping the published fields', async () => {
    const tracker = calls()
    const publication = publicationStub({ getPerson: () => ({ id: 'p', firstName: 'A', lastName: 'B', email: null, phone: null, bio: 'published bio', country: null, externalAccountId: null, photoToken: null }) })
    const client = createHybridClient({ publication, xapi: xapiStub(tracker), log: { warn () {} } })
    const person = await client.getPerson('p')
    expect(person).toMatchObject({ email: 'x@api.ee', phone: '+1', bio: 'published bio', emailSource: 'xapi' })
    expect(tracker.log).toEqual([['xapi.getPerson', 'p']])
  })

  it('falls back to the XAPI for the MyPoff link and the photo when the published record has none', async () => {
    const tracker = calls()
    const publication = publicationStub({ getMyPoffUserId: () => null, getPersonPhoto: () => null })
    const client = createHybridClient({ publication, xapi: xapiStub(tracker), log: { warn () {} } })
    expect(await client.getMyPoffUserId('p')).toBe('99')
    expect((await client.getPersonPhoto('p')).buffer.toString()).toBe('xapi')
    expect(tracker.log.map(c => c[0])).toEqual(['xapi.getMyPoffUserId', 'xapi.getPersonPhoto'])
  })

  it('keeps the published person and warns when the XAPI fallback fails', async () => {
    const warnings = []
    const publication = publicationStub({ getPerson: () => ({ id: 'p', firstName: 'A', lastName: 'B', email: null, phone: null, bio: null, country: null, externalAccountId: null, photoToken: null }), getMyPoffUserId: () => null, getPersonPhoto: () => null })
    const xapi = { getPerson: () => { throw new Error('xapi down') }, getMyPoffUserId: () => { throw new Error('xapi down') }, getPersonPhoto: () => { throw new Error('xapi down') } }
    const client = createHybridClient({ publication, xapi, log: { warn: m => warnings.push(m) } })
    expect((await client.getPerson('p')).email).toBeNull()
    expect(await client.getMyPoffUserId('p')).toBeNull()
    expect(await client.getPersonPhoto('p')).toBeNull()
    expect(warnings.join('\n')).toMatch(/xapi down/)
  })

  it('works without an XAPI client at all', async () => {
    const publication = publicationStub({ getPerson: () => ({ id: 'p', firstName: 'A', lastName: 'B', email: null, phone: null, bio: null, country: null, externalAccountId: null, photoToken: null }), getMyPoffUserId: () => null, getPersonPhoto: () => null })
    const client = createHybridClient({ publication, log: { warn () {} } })
    expect((await client.getPerson('p')).email).toBeNull()
    expect(await client.getMyPoffUserId('p')).toBeNull()
    expect(await client.getPersonPhoto('p')).toBeNull()
  })
})
