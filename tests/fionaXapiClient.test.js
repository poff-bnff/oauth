import { describe, it, expect } from 'vitest'
import { normalizeBadges, normalizeAccreditation, normalizePerson, pickPhotoAttachment, createXapiClient } from '../server/utils/fiona/xapiClient.js'

describe('normalizeBadges', () => {
  it('maps the PascalCase XAPI badge shape to badgeId / badgeName / statusText', () => {
    const raw = [{
      GuestbookBadge: { Description: 'Industry badge', Id: 'A66A8769-653E-417B-8890-B8798226178F' },
      Status: { Description: 'Approved', Id: 'e45a518a' },
      Id: 'e497ab0a',
      Code: 'X'
    }]
    expect(normalizeBadges(raw)).toEqual([{ badgeId: 'A66A8769-653E-417B-8890-B8798226178F', badgeName: 'Industry badge', statusText: 'Approved' }])
  })

  it('tolerates camelCase and drops badges without a name and id', () => {
    const raw = [
      { guestbookBadge: { description: 'Press', id: 'g1' }, status: { description: 'Created' } },
      { Status: { Description: 'Created' } }
    ]
    expect(normalizeBadges(raw)).toEqual([{ badgeId: 'g1', badgeName: 'Press', statusText: 'Created' }])
  })

  it('returns an empty list for a non-array', () => {
    expect(normalizeBadges(null)).toEqual([])
  })
})

describe('normalizeAccreditation', () => {
  it('extracts the person id, the privacy flag and the films', () => {
    const raw = {
      Person: { Description: 'Digna', Id: '6bca9b32' },
      NoPublicationOfContactDetails: true,
      Films: [{ Description: '127 Hours', Id: 'a7a74176' }]
    }
    expect(normalizeAccreditation(raw)).toEqual({
      personId: '6bca9b32',
      noPublicationOfContactDetails: true,
      films: [{ id: 'a7a74176', title: '127 Hours' }]
    })
  })

  it('accepts the camelCase variant and defaults the flag to false', () => {
    expect(normalizeAccreditation({ person: { id: 'p' } })).toEqual({ personId: 'p', noPublicationOfContactDetails: false, films: [] })
  })
})

describe('normalizePerson', () => {
  const person = { firstName: 'Digna', lastName: 'Nielen', prefix: 'van', address: { country: { description: 'Netherlands', id: 'c1' } } }

  it('takes email and phone from communication items, preferring the default one', () => {
    const comms = [
      { type: { description: 'Email' }, value: 'second@x.nl', isDefault: false },
      { type: { description: 'Email' }, value: 'first@x.nl', isDefault: true },
      { type: { description: 'Phone' }, value: '+31 10' }
    ]
    expect(normalizePerson(person, comms)).toEqual({
      firstName: 'Digna',
      lastName: 'Nielen',
      email: 'first@x.nl',
      phone: '+31 10',
      bio: null,
      country: { id: 'c1', name: 'Netherlands' }
    })
  })

  it('handles PascalCase person fields and missing communication items', () => {
    expect(normalizePerson({ FirstName: 'A', LastName: 'B', Biography: 'bio' }, null)).toEqual({
      firstName: 'A', lastName: 'B', email: null, phone: null, bio: 'bio', country: null
    })
  })
})

describe('createXapiClient', () => {
  it('lists all guestbooks known to the API key as { id, name }', async () => {
    const calls = []
    const fetch = (url, options) => {
      calls.push({ url, options })
      return [
        { id: 'gb-1', description: 'Guestbook 2025', createdOn: 'x' },
        { Id: 'gb-2', Description: 'Guestbook 2026' }
      ]
    }
    const client = createXapiClient({ fetch, apiKey: 'KEY', log: { warn () {} } })
    expect(await client.listGuestbooks()).toEqual([{ id: 'gb-1', name: 'Guestbook 2025' }, { id: 'gb-2', name: 'Guestbook 2026' }])
    expect(calls[0].url).toBe('https://poff-xapi.fiona-app.com/api/guestbooks')
    expect(calls[0].options.headers['X-ApiKey']).toBe('KEY')
  })
})

describe('pickPhotoAttachment', () => {
  it('prefers a publication image (category 2) over a plain image (category 0)', () => {
    const attachments = [
      { category: 0, contentType: { description: 'image/png' }, value: 'tok0' },
      { category: 2, contentType: { description: 'Image' }, value: 'tok2' },
      { category: 2, contentType: { description: 'application/pdf' }, value: 'pdf' }
    ]
    expect(pickPhotoAttachment(attachments)).toBe('tok2')
  })

  it('returns null when there is no image', () => {
    expect(pickPhotoAttachment([{ category: 2, contentType: { description: 'PDF' }, value: 'x' }])).toBeNull()
    expect(pickPhotoAttachment(undefined)).toBeNull()
  })
})
