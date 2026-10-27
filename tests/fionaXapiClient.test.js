import { describe, it, expect } from 'vitest'
import { normalizeBadges, normalizeAccreditation, normalizePerson, pickPhotoAttachment, normalizeAttachments, pickHeadshot, createXapiClient } from '../server/utils/fiona/xapiClient.js'

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
      Guestbook: { Description: 'Gastenboek 2022', Id: 'gb-2022' },
      NoPublicationOfContactDetails: true,
      Films: [{ Description: '127 Hours', Id: 'a7a74176' }]
    }
    expect(normalizeAccreditation(raw)).toEqual({
      personId: '6bca9b32',
      guestbookId: 'gb-2022',
      noPublicationOfContactDetails: true,
      films: [{ id: 'a7a74176', title: '127 Hours' }]
    })
  })

  it('accepts the camelCase variant and defaults the flag to false', () => {
    expect(normalizeAccreditation({ person: { id: 'p' } })).toEqual({ personId: 'p', guestbookId: null, noPublicationOfContactDetails: false, films: [] })
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

describe('normalizeAttachments', () => {
  it('maps PascalCase and camelCase attachments to id, category, type, content type, title, file name and token', () => {
    const raw = [
      { Id: 'att-1', Category: 2, Type: { Description: 'Image' }, ContentType: { Description: 'Headshot' }, Title: 'Photo of yourself', OriginalFileName: 'tonis.jpg', CreatedOn: '2026-09-01T10:00:00Z', Value: 'TOKEN1' },
      { id: 'att-2', category: 0, type: { description: 'Document' }, contentType: null, title: 'CV', originalFileName: 'cv.pdf', value: 'TOKEN2' }
    ]
    expect(normalizeAttachments(raw)).toEqual([
      { id: 'att-1', category: 2, type: 'Image', contentType: 'Headshot', title: 'Photo of yourself', fileName: 'tonis.jpg', createdOn: '2026-09-01T10:00:00Z', token: 'TOKEN1' },
      { id: 'att-2', category: 0, type: 'Document', contentType: null, title: 'CV', fileName: 'cv.pdf', createdOn: null, token: 'TOKEN2' }
    ])
  })

  it('reads the content type whether it comes as an object with description or key, or as plain text', () => {
    const labels = [
      { ContentType: { Description: 'Headshot' } },
      { contentType: { key: 'Showcase' } },
      { contentType: 'Headshot' },
      { contentType: undefined }
    ].map(item => normalizeAttachments([item])[0].contentType)
    expect(labels).toEqual(['Headshot', 'Showcase', 'Headshot', null])
  })

  it('returns an empty list for anything that is not a list', () => {
    expect(normalizeAttachments(undefined)).toEqual([])
    expect(normalizeAttachments(null)).toEqual([])
    expect(normalizeAttachments({})).toEqual([])
  })
})

describe('pickHeadshot', () => {
  const image = (overrides = {}) => ({ id: 'a', category: 0, type: 'Image', contentType: 'Headshot', title: 'anything', fileName: 'one.jpg', createdOn: '2026-09-01T10:00:00Z', token: 'T1', ...overrides })

  it('takes an image whose content type is Headshot, whatever its title or file name', () => {
    const picked = pickHeadshot([image({ title: 'LASTE - Domi Karu.jpg', fileName: 'whatever.png' })])
    expect(picked).toMatchObject({ token: 'T1', fileName: 'whatever.png', otherFiles: 0 })
  })

  it('ignores other content types, attachments that are not images and images without a content type', () => {
    expect(pickHeadshot([
      image({ contentType: 'Showcase' }),
      image({ contentType: null }),
      image({ type: 'Document', fileName: 'ticket.pdf' }),
      image({ type: 'URL', contentType: 'Headshot', fileName: 'link' })
    ])).toBeNull()
  })

  it('matches the label ignoring case and spaces', () => {
    expect(pickHeadshot([image({ contentType: '  headSHOT ' })])).not.toBeNull()
  })

  it('takes the newest of several headshots and counts the other distinct files, not repeated uploads of one file', () => {
    const picked = pickHeadshot([
      image({ token: 'OLD', fileName: 'a.jpg', createdOn: '2026-09-01T10:00:00Z' }),
      image({ token: 'NEW', fileName: 'b.jpg', createdOn: '2026-10-01T10:00:00Z' }),
      image({ token: 'DUP', fileName: 'a.jpg', createdOn: '2026-09-15T10:00:00Z' })
    ])
    expect(picked).toMatchObject({ token: 'NEW', fileName: 'b.jpg', otherFiles: 1, choice: 'latest' })
  })

  it('prefers the default headshot, the one Fiona marks with the star, even when another one is newer', () => {
    const picked = pickHeadshot([
      image({ id: 'star', token: 'STAR', fileName: 'main.jpg', createdOn: '2026-08-10T10:00:00Z' }),
      image({ id: 'later', token: 'LATER', fileName: 'other.jpg', createdOn: '2026-09-24T10:00:00Z' })
    ], ['star'])
    expect(picked).toMatchObject({ token: 'STAR', otherFiles: 1, choice: 'default' })
  })

  it('when no default is detected, takes the latest headshot', () => {
    const picked = pickHeadshot([
      image({ id: 'old', token: 'OLD', fileName: 'a.jpg', createdOn: '2026-08-10T10:00:00Z' }),
      image({ id: 'later', token: 'LATER', fileName: 'b.jpg', createdOn: '2026-09-24T10:00:00Z' })
    ], [])
    expect(picked).toMatchObject({ token: 'LATER', otherFiles: 1, choice: 'latest' })
  })

  it('a favourite that is not a headshot does not count as the default', () => {
    const picked = pickHeadshot([
      image({ id: 'h1', token: 'H1', fileName: 'a.jpg', createdOn: '2026-08-10T10:00:00Z' }),
      image({ id: 'h2', token: 'H2', fileName: 'b.jpg', createdOn: '2026-09-24T10:00:00Z' }),
      image({ id: 'show', token: 'SHOW', contentType: 'Showcase', fileName: 'c.jpg' })
    ], ['show'])
    expect(picked).toMatchObject({ token: 'H2', choice: 'latest' })
  })

  it('a single headshot file needs no choice, repeated uploads of the same file are one file', () => {
    expect(pickHeadshot([image({ id: 'x' }), image({ id: 'y', createdOn: '2026-09-02T10:00:00Z' })], ['x'])).toMatchObject({ otherFiles: 0, choice: 'only' })
  })

  it('returns null for nothing at all', () => {
    expect(pickHeadshot([])).toBeNull()
    expect(pickHeadshot(undefined)).toBeNull()
  })
})

describe('createXapiClient attachment lists', () => {
  const make = (response) => {
    const calls = []
    const fetch = (url) => { calls.push(url); return response }
    return { client: createXapiClient({ fetch, apiKey: 'KEY', log: { warn () {} } }), calls }
  }

  it('lists the attachments of a person and of an accreditation, published or not', async () => {
    const { client, calls } = make([{ category: 0, type: { description: 'Image' }, title: 'a', originalFileName: 'a.jpg', value: 'T' }])
    expect(await client.listPersonAttachments('p 1')).toHaveLength(1)
    expect(await client.listAccreditationAttachments('acc-1')).toHaveLength(1)
    expect(calls).toEqual([
      'https://poff-xapi.fiona-app.com/api/person/p%201/attachments',
      'https://poff-xapi.fiona-app.com/api/accreditation/acc-1/attachments'
    ])
  })
})

describe('createXapiClient photos', () => {
  const headshot = { Id: 'att-1', Category: 0, Type: { Description: 'Image' }, ContentType: { Description: 'Headshot' }, Title: 'Photo of yourself', OriginalFileName: 'x.jpg', CreatedOn: '2026-09-01T10:00:00Z', Value: 'TOK 1' }
  const BASE = 'https://poff-xapi.fiona-app.com/api'
  const make = (route) => {
    const calls = []
    const downloads = []
    const fetch = (url) => {
      calls.push(url)
      const response = route(url.replace(BASE, ''))
      if (response === undefined) throw new Error(`unexpected ${url}`)
      return response
    }
    const download = (url) => { downloads.push(url); return Buffer.from('img') }
    return { client: createXapiClient({ fetch, apiKey: 'KEY', log: { warn () {} }, download }), calls, downloads }
  }

  it('downloads the Headshot of the person or its accreditations through the short-lived URL, published or not', async () => {
    const { client, calls, downloads } = make((path) => {
      if (path === '/person/p1/attachments') return []
      if (path === '/accreditation/a1/attachments') return [headshot]
      if (path === '/person/p1' || path === '/accreditation/a1') return {}
      if (path.startsWith('/attachment/url?token=')) return { accessUrl: 'https://s3.example/x.jpg' }
    })

    const photo = await client.getUnpublishedHeadshot('p1', ['a1'])

    expect(photo).toMatchObject({ filename: 'fiona-person-p1.jpg', fileName: 'x.jpg', otherFiles: 0, choice: 'only' })
    expect(photo.buffer.toString()).toBe('img')
    expect(calls).toContain(`${BASE}/attachment/url?token=TOK%201`)
    expect(downloads).toEqual(['https://s3.example/x.jpg'])
  })

  it('takes the default (starred) headshot of the accreditation when there are two', async () => {
    const starred = { ...headshot, Id: 'star', Value: 'STAR TOKEN', OriginalFileName: 'main.jpg', CreatedOn: '2026-08-10T10:00:00Z' }
    const later = { ...headshot, Id: 'later', Value: 'LATE TOKEN', OriginalFileName: 'other.jpg', CreatedOn: '2026-09-24T10:00:00Z' }
    const { client, calls } = make((path) => {
      if (path === '/person/p1/attachments') return []
      if (path === '/accreditation/a1/attachments') return [later, starred]
      if (path === '/accreditation/a1') return { FavoriteImageAttachment: { Id: 'star' } }
      if (path === '/person/p1') return {}
      if (path.startsWith('/attachment/url?token=')) return 'https://s3.example/main.jpg'
    })

    const photo = await client.getUnpublishedHeadshot('p1', ['a1'])

    expect(photo).toMatchObject({ fileName: 'main.jpg', otherFiles: 1, choice: 'default' })
    expect(calls).toContain(`${BASE}/attachment/url?token=STAR%20TOKEN`)
  })

  it('takes the latest headshot when Fiona names no default', async () => {
    const older = { ...headshot, Id: 'old', Value: 'OLD TOKEN', OriginalFileName: 'a.jpg', CreatedOn: '2026-08-10T10:00:00Z' }
    const later = { ...headshot, Id: 'later', Value: 'LATE TOKEN', OriginalFileName: 'b.jpg', CreatedOn: '2026-09-24T10:00:00Z' }
    const { client, calls } = make((path) => {
      if (path === '/person/p1/attachments') return []
      if (path === '/accreditation/a1/attachments') return [older, later]
      if (path === '/accreditation/a1' || path === '/person/p1') return { FavoriteImageAttachment: null }
      if (path.startsWith('/attachment/url?token=')) return 'https://s3.example/b.jpg'
    })

    const photo = await client.getUnpublishedHeadshot('p1', ['a1'])

    expect(photo).toMatchObject({ fileName: 'b.jpg', choice: 'latest' })
    expect(calls).toContain(`${BASE}/attachment/url?token=LATE%20TOKEN`)
  })

  it('still finds the latest headshot when the lookup of the default fails', async () => {
    const { client } = make((path) => {
      if (path === '/person/p1/attachments') return []
      if (path === '/accreditation/a1/attachments') return [headshot]
      if (path === '/person/p1' || path === '/accreditation/a1') throw new Error('Fiona hiccup')
      if (path.startsWith('/attachment/url?token=')) return 'https://s3.example/x.jpg'
    })

    expect(await client.getUnpublishedHeadshot('p1', ['a1'])).toMatchObject({ fileName: 'x.jpg' })
  })

  it('returns null and downloads nothing when no attachment has the content type Headshot', async () => {
    const { client, downloads } = make((path) => {
      if (path === '/person/p1/attachments') return [{ ...headshot, ContentType: { Description: 'Showcase' } }]
      if (path === '/accreditation/a1/attachments') return [{ ...headshot, Type: { Description: 'Document' } }]
      if (path === '/person/p1' || path === '/accreditation/a1') return {}
    })

    expect(await client.getUnpublishedHeadshot('p1', ['a1'])).toBeNull()
    expect(downloads).toEqual([])
  })

  it('the older person photo lookup asks for the short-lived URL at /attachment/url?token=', async () => {
    const { client, calls } = make((path) => {
      if (path === '/person/p1/attachments') return [{ Category: 2, Type: { Description: 'Image' }, ContentType: { Description: 'Image' }, Value: 'TOK' }]
      if (path.startsWith('/attachment/url?token=')) return 'https://s3.example/y.jpg'
    })

    await client.getPersonPhoto('p1')

    expect(calls).toContain(`${BASE}/attachment/url?token=TOK`)
  })
})
