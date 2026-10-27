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

  it('falls back to the XAPI for the MyPoff link when the published record has none, but never for the photo', async () => {
    const tracker = calls()
    const publication = publicationStub({ getMyPoffUserId: () => null, getPersonPhoto: () => null })
    const client = createHybridClient({ publication, xapi: xapiStub(tracker), log: { warn () {} } })
    expect(await client.getMyPoffUserId('p')).toBe('99')
    expect(await client.getPersonPhoto('p')).toBeNull()
    expect(tracker.log.map(c => c[0])).toEqual(['xapi.getMyPoffUserId'])
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

  describe('photos', () => {
    const opts = { accreditationIds: ['acc'], level: 2 }
    const xapiWithHeadshot = (tracker, overrides = {}) => xapiStub(tracker, {
      getUnpublishedHeadshot: (...a) => { tracker.record('xapi.getUnpublishedHeadshot')(...a); return { buffer: Buffer.from('hs'), filename: 'fiona-person-p.jpg', fileName: 'h.jpg', otherFiles: 0 } },
      ...overrides
    })

    it('uses the published photo first and never asks the XAPI', async () => {
      const tracker = calls()
      const client = createHybridClient({ publication: publicationStub(), xapi: xapiWithHeadshot(tracker), allowUnpublishedPhotos: true, log: { warn () {} } })
      const photo = await client.getPersonPhoto('p', opts)
      expect(photo).toMatchObject({ source: 'published' })
      expect(tracker.log).toEqual([])
    })

    it('without the switch a person without a published photo gets none and the XAPI is not asked', async () => {
      const tracker = calls()
      const client = createHybridClient({ publication: publicationStub({ getPersonPhoto: () => null }), xapi: xapiWithHeadshot(tracker), log: { warn () {} } })
      expect(await client.getPersonPhoto('p', opts)).toBeNull()
      expect(tracker.log).toEqual([])
    })

    it('with the switch on, a full-profile person without a published photo gets the XAPI Headshot, marked as such', async () => {
      const tracker = calls()
      const client = createHybridClient({ publication: publicationStub({ getPersonPhoto: () => null }), xapi: xapiWithHeadshot(tracker), allowUnpublishedPhotos: true, log: { warn () {} } })
      const photo = await client.getPersonPhoto('p', opts)
      expect(photo).toMatchObject({ source: 'headshot', filename: 'fiona-person-p.jpg' })
      expect(tracker.log).toEqual([['xapi.getUnpublishedHeadshot', 'p', ['acc']]])
    })

    it('a basic-level person gets no XAPI lookup', async () => {
      const tracker = calls()
      const client = createHybridClient({ publication: publicationStub({ getPersonPhoto: () => null }), xapi: xapiWithHeadshot(tracker), allowUnpublishedPhotos: true, log: { warn () {} } })
      expect(await client.getPersonPhoto('p', { accreditationIds: ['acc'], level: 1 })).toBeNull()
      expect(tracker.log).toEqual([])
    })

    it('an XAPI failure leaves the person without a photo and does not stop the sync', async () => {
      const tracker = calls()
      const failing = xapiWithHeadshot(tracker, { getUnpublishedHeadshot: () => { throw new Error('Fiona down') } })
      const client = createHybridClient({ publication: publicationStub({ getPersonPhoto: () => null }), xapi: failing, allowUnpublishedPhotos: true, log: { warn () {} } })
      expect(await client.getPersonPhoto('p', opts)).toBeNull()
    })
  })

  describe('biographies', () => {
    const opts = { accreditationIds: ['acc'], level: 2 }
    const xapiWithBio = (tracker, overrides = {}) => xapiStub(tracker, {
      getUnpublishedBiography: (...a) => { tracker.record('xapi.getUnpublishedBiography')(...a); return { text: 'Card bio' } },
      ...overrides
    })
    const publicationPerson = bio => ({ getPerson: () => ({ id: 'p', firstName: 'A', lastName: 'B', email: 'a@b.ee', phone: null, bio, country: null, externalAccountId: '5', photoToken: 'tok' }) })

    it('keeps the published biography and does not ask the XAPI', async () => {
      const tracker = calls()
      const client = createHybridClient({ publication: publicationStub(publicationPerson('Published bio')), xapi: xapiWithBio(tracker), allowUnpublishedBios: true, log: { warn () {} } })
      const person = await client.getPerson('p', opts)
      expect(person).toMatchObject({ bio: 'Published bio', bioSource: 'published' })
      expect(tracker.log).toEqual([])
    })

    it('without the switch a person without a published biography gets none', async () => {
      const tracker = calls()
      const client = createHybridClient({ publication: publicationStub(publicationPerson(null)), xapi: xapiWithBio(tracker), log: { warn () {} } })
      expect((await client.getPerson('p', opts)).bio).toBeNull()
      expect(tracker.log).toEqual([])
    })

    it('with the switch on, a full-profile person without a published biography gets the accreditation card biography', async () => {
      const tracker = calls()
      const client = createHybridClient({ publication: publicationStub(publicationPerson(null)), xapi: xapiWithBio(tracker), allowUnpublishedBios: true, log: { warn () {} } })
      const person = await client.getPerson('p', opts)
      expect(person).toMatchObject({ bio: 'Card bio', bioSource: 'accreditation' })
      expect(tracker.log).toEqual([['xapi.getUnpublishedBiography', ['acc']]])
    })

    it('a basic-level person gets no XAPI lookup', async () => {
      const tracker = calls()
      const client = createHybridClient({ publication: publicationStub(publicationPerson(null)), xapi: xapiWithBio(tracker), allowUnpublishedBios: true, log: { warn () {} } })
      expect((await client.getPerson('p', { accreditationIds: ['acc'], level: 1 })).bio).toBeNull()
      expect(tracker.log).toEqual([])
    })

    it('an XAPI failure leaves the person without a biography and does not stop the sync', async () => {
      const tracker = calls()
      const failing = xapiWithBio(tracker, { getUnpublishedBiography: () => { throw new Error('Fiona down') } })
      const client = createHybridClient({ publication: publicationStub(publicationPerson(null)), xapi: failing, allowUnpublishedBios: true, log: { warn () {} } })
      expect((await client.getPerson('p', opts)).bio).toBeNull()
    })
  })
})
