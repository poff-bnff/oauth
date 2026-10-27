import { describe, it, expect } from 'vitest'
import { normalizeAccreditationRecord, privacyFlagsFromCustomFields, toFionaTimestamp, createPublicationClient } from '../server/utils/fiona/publicationClient.js'

const lookup = (key, en) => ({ key, translations: [{ language: 'nl', text: `${en} nl` }, { language: 'en', text: en }] })

function rawRecord (overrides = {}) {
  return {
    id: 'acc-1',
    guestbook: { id: 'gb-30', description: 'PÖFF 30' },
    noPublicationOfContactDetails: false,
    status: lookup('guest', 'Guest'),
    type: lookup('Guest', 'Guest'),
    badges: [
      { id: 'b1', guestbookBadge: { id: 'badge-pro', description: 'Industry PRO' }, status: lookup('approved', 'Approved') },
      { id: 'b2', guestbookBadge: { id: 'badge-guest', description: 'Guest' }, status: lookup('paid', 'Paid') }
    ],
    films: [{ id: 'rel-1', edition: { id: 'ed-1' }, fullPreferredTitle: 'Film A', roles: [lookup('director', 'Director')] }],
    image: null,
    publications: [{ id: 'pub-acc', type: lookup('image', 'Image'), value: 'token-acc' }],
    favoriteImageAttachmentId: null,
    person: {
      id: 'person-1',
      firstName: 'Mari',
      lastName: 'Maasikas',
      externalAccountId: '22135',
      favoriteImageAttachmentId: 'pub-fav',
      address: { country: lookup('estonia', 'Estonia') },
      contactDetails: [
        { id: 'c1', type: lookup('Phone', 'Phone'), value: '+372 555' },
        { id: 'c2', type: lookup('Email', 'Email'), value: 'mari@example.com' }
      ],
      texts: [{ id: 't1', type: lookup('biography', 'Biography'), translations: [{ html: '<p>Bio et</p>', language: 'et' }, { html: '<p>Bio en</p>', language: 'en' }] }],
      publications: [
        { id: 'pub-other', type: lookup('image', 'Image'), value: 'token-other' },
        { id: 'pub-fav', type: lookup('image', 'Image'), value: 'token-fav' },
        { id: 'pub-doc', type: lookup('document', 'Document'), value: 'token-doc' }
      ]
    },
    ...overrides
  }
}

describe('normalizeAccreditationRecord', () => {
  it('maps badges to badgeId / badgeName / statusText (English text) / statusKey', () => {
    const rec = normalizeAccreditationRecord(rawRecord())
    expect(rec.id).toBe('acc-1')
    expect(rec.guestbookId).toBe('gb-30')
    expect(rec.personId).toBe('person-1')
    expect(rec.badges).toEqual([
      { badgeId: 'badge-pro', badgeName: 'Industry PRO', statusText: 'Approved', statusKey: 'approved' },
      { badgeId: 'badge-guest', badgeName: 'Guest', statusText: 'Paid', statusKey: 'paid' }
    ])
    expect(rec.noPublicationOfContactDetails).toBe(false)
  })

  it('maps the published person: names, email, phone, English biography, country, MyPoff link', () => {
    const { person } = normalizeAccreditationRecord(rawRecord())
    expect(person).toMatchObject({
      id: 'person-1',
      firstName: 'Mari',
      lastName: 'Maasikas',
      email: 'mari@example.com',
      phone: '+372 555',
      bio: '<p>Bio en</p>',
      country: { id: 'estonia', name: 'Estonia' },
      externalAccountId: '22135'
    })
  })

  it('prefers the favourite image publication as the photo token, then the accreditation image, then any image', () => {
    expect(normalizeAccreditationRecord(rawRecord()).person.photoToken).toBe('token-fav')
    const noFav = rawRecord({ person: { ...rawRecord().person, favoriteImageAttachmentId: null, publications: [] }, image: { value: 'token-image' } })
    expect(normalizeAccreditationRecord(noFav).person.photoToken).toBe('token-image')
    const onlyAcc = rawRecord({ person: { ...rawRecord().person, favoriteImageAttachmentId: null, publications: [] }, image: null })
    expect(normalizeAccreditationRecord(onlyAcc).person.photoToken).toBe('token-acc')
    const none = rawRecord({ person: { ...rawRecord().person, favoriteImageAttachmentId: null, publications: [] }, image: null, publications: [] })
    expect(normalizeAccreditationRecord(none).person.photoToken).toBeNull()
  })

  it('maps films with edition, title and role keys', () => {
    expect(normalizeAccreditationRecord(rawRecord()).films).toEqual([{ id: 'rel-1', editionId: 'ed-1', title: 'Film A', roles: ['director'] }])
  })

  it('tolerates a record without badges, films, texts or contact details', () => {
    const rec = normalizeAccreditationRecord({ id: 'x', person: { id: 'p' } })
    expect(rec.badges).toEqual([])
    expect(rec.films).toEqual([])
    expect(rec.person).toMatchObject({ id: 'p', email: null, phone: null, bio: null, country: null, externalAccountId: null, photoToken: null })
  })
})

describe('toFionaTimestamp', () => {
  it('formats a date as yyyyMMddTHHmmssSSSZ in UTC', () => {
    expect(toFionaTimestamp(new Date('2026-09-01T00:00:00.000Z'))).toBe('20260901T000000000Z')
    expect(toFionaTimestamp('2023-10-13T08:46:20.524Z')).toBe('20231013T084620524Z')
  })
})

describe('createPublicationClient', () => {
  const BASE = 'https://poff-online-api.fiona-online.net/v1'

  function fakeFetch (routes) {
    const calls = []
    const fetch = (url, options = {}) => {
      calls.push({ url, headers: options.headers || {} })
      const path = url.replace(BASE, '')
      for (const [prefix, response] of Object.entries(routes)) {
        if (path.startsWith(prefix)) return typeof response === 'function' ? response(path) : response
      }
      const err = new Error(`404 ${path}`)
      err.statusCode = 404
      throw err
    }
    return { fetch, calls }
  }

  const make = (routes) => {
    const { fetch, calls } = fakeFetch(routes)
    return { client: createPublicationClient({ fetch, apiKey: 'PUBKEY', baseUrl: BASE, log: { warn () {} }, download: () => Buffer.from('img') }), calls }
  }

  it('sends the apikey header and lists guestbooks, badges and accreditations', async () => {
    const { client, calls } = make({
      '/guestbooks/gb-30/accreditations': [{ id: 'acc-1', person: { id: 'person-1', fullName: 'Mari Maasikas' } }],
      '/guestbooks/gb-30': { id: 'gb-30', badges: [{ id: 'badge-pro', description: 'Industry PRO' }] },
      '/guestbooks': [{ id: 'gb-30', name: 'PÖFF 30' }]
    })
    expect(await client.listGuestbooks()).toEqual([{ id: 'gb-30', name: 'PÖFF 30' }])
    expect(await client.listGuestbookBadges('gb-30')).toEqual([{ id: 'badge-pro', name: 'Industry PRO' }])
    expect(await client.listAccreditations('gb-30')).toEqual([{ id: 'acc-1', personId: 'person-1' }])
    expect(calls.every(c => c.headers.apikey === 'PUBKEY')).toBe(true)
  })

  it('fetches an accreditation once and serves badges, detail, person and MyPoff id from it', async () => {
    const { client, calls } = make({ '/accreditations/acc-1': rawRecord() })
    expect(await client.getAccreditationBadges('acc-1')).toHaveLength(2)
    expect(await client.getAccreditation('acc-1')).toMatchObject({ personId: 'person-1', guestbookId: 'gb-30', noPublicationOfContactDetails: false })
    expect(await client.getPerson('person-1')).toMatchObject({ firstName: 'Mari', email: 'mari@example.com' })
    expect(await client.getMyPoffUserId('person-1')).toBe('22135')
    expect(calls.filter(c => c.url.includes('/accreditations/acc-1'))).toHaveLength(1)
  })

  it('resolves a person not seen yet through /persons/{id} and one of its accreditations', async () => {
    const { client } = make({
      '/persons/person-1': { id: 'person-1', accreditations: [{ id: 'acc-1', guestbook: { id: 'gb-30' } }] },
      '/accreditations/acc-1': rawRecord()
    })
    expect(await client.getPerson('person-1')).toMatchObject({ lastName: 'Maasikas' })
    expect(await client.getPersonAccreditations('person-1')).toEqual([{ id: 'acc-1', guestbookId: 'gb-30' }])
  })

  it('downloads the photo through the attachment token', async () => {
    const { client } = make({ '/accreditations/acc-1': rawRecord(), '/attachments/token-fav': 'https://s3.example/photo.jpg' })
    await client.getAccreditation('acc-1')
    const photo = await client.getPersonPhoto('person-1')
    expect(photo.buffer.toString()).toBe('img')
    expect(photo.filename).toBe('fiona-person-person-1.jpg')
  })

  it('lists mutations since a date and resolves an accreditation badge to its accreditation', async () => {
    const { client, calls } = make({
      '/mutations/20260901T000000000Z': [{ entityName: 'Accreditation', entityId: 'acc-1', mutation: 1, entityUpdatedOn: '2026-09-02T00:00:00Z' }],
      '/accreditationbadges/b1': { id: 'b1', accreditation: { id: 'acc-1' } }
    })
    expect(await client.listMutations('2026-09-01T00:00:00.000Z')).toEqual([{ entityName: 'Accreditation', entityId: 'acc-1', mutation: 1, entityUpdatedOn: '2026-09-02T00:00:00Z' }])
    expect(await client.getAccreditationBadgeRecord('b1')).toEqual({ accreditationId: 'acc-1' })
    expect(calls[0].url).toBe(`${BASE}/mutations/20260901T000000000Z`)
  })
})

describe('privacy flags from the accreditation custom fields', () => {
  const EMAIL_KEY = 'accreditation-general-do-not-publish-email-info'
  const PHONE_KEY = 'accreditation-general-do-not-publish-phone-info'

  it('reads "Do not publish email info" and "Do not publish phone info" independently', () => {
    expect(privacyFlagsFromCustomFields([{ key: EMAIL_KEY, value: true }, { key: PHONE_KEY, value: false }]))
      .toEqual({ noPublicationOfEmail: true, noPublicationOfPhone: false })
    expect(privacyFlagsFromCustomFields([{ key: EMAIL_KEY, value: false }, { key: PHONE_KEY, value: true }]))
      .toEqual({ noPublicationOfEmail: false, noPublicationOfPhone: true })
  })

  it('accepts text and number values that mean yes', () => {
    for (const yes of ['true', 'TRUE', 'yes', 'Yes', '1', 1, 'on']) {
      expect(privacyFlagsFromCustomFields([{ key: EMAIL_KEY, value: yes }]).noPublicationOfEmail).toBe(true)
    }
    for (const no of [false, 'false', 'no', '0', 0, '', null, undefined]) {
      expect(privacyFlagsFromCustomFields([{ key: EMAIL_KEY, value: no }]).noPublicationOfEmail).toBe(false)
    }
  })

  it('finds the key whatever the separators and case, and ignores unrelated custom fields', () => {
    expect(privacyFlagsFromCustomFields([{ key: 'Accreditation_General_Do_Not_Publish_Email_Info', value: true }]).noPublicationOfEmail).toBe(true)
    expect(privacyFlagsFromCustomFields([{ key: 'do not publish phone info', value: true }]).noPublicationOfPhone).toBe(true)
    expect(privacyFlagsFromCustomFields([{ key: 'accreditation-general-delivered-by', value: true }])).toEqual({ noPublicationOfEmail: false, noPublicationOfPhone: false })
  })

  it('is false when the record has no custom fields at all', () => {
    expect(privacyFlagsFromCustomFields(undefined)).toEqual({ noPublicationOfEmail: false, noPublicationOfPhone: false })
    expect(privacyFlagsFromCustomFields([])).toEqual({ noPublicationOfEmail: false, noPublicationOfPhone: false })
  })

  it('puts the flags and the normalised custom fields on the accreditation record', () => {
    const rec = normalizeAccreditationRecord(rawRecord({
      customFieldValues: [{ key: EMAIL_KEY, value: true }, { key: 'accreditation-general-delivered-by', value: '2026-10-28' }]
    }))
    expect(rec.noPublicationOfEmail).toBe(true)
    expect(rec.noPublicationOfPhone).toBe(false)
    expect(rec.customFields).toEqual([{ key: EMAIL_KEY, value: true }, { key: 'accreditation-general-delivered-by', value: '2026-10-28' }])
  })

  it('defaults to "publishable" when the record carries no custom fields', () => {
    const rec = normalizeAccreditationRecord(rawRecord())
    expect(rec.noPublicationOfEmail).toBe(false)
    expect(rec.noPublicationOfPhone).toBe(false)
    expect(rec.customFields).toEqual([])
  })
})

describe('createPublicationClient photo without download', () => {
  const BASE = 'https://poff-online-api.fiona-online.net/v1'
  it('says there is a published photo without asking for the address or downloading it when download is false', async () => {
    const calls = []
    const downloads = []
    const fetch = (url) => {
      calls.push(url.replace(BASE, ''))
      if (url.includes('/accreditations/acc-1')) return rawRecord()
      return 'https://s3.example/photo.jpg'
    }
    const client = createPublicationClient({ fetch, apiKey: 'K', baseUrl: BASE, log: { warn () {} }, download: (u) => { downloads.push(u); return Buffer.from('img') } })
    await client.getAccreditationBadges('acc-1') // loads the record the person comes from

    const photo = await client.getPersonPhoto('person-1', { download: false })

    expect(photo).toEqual({ buffer: null, filename: 'fiona-person-person-1.jpg' })
    expect(calls.filter(c => c.startsWith('/attachments'))).toEqual([])
    expect(downloads).toEqual([])
  })
})
