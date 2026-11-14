import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

// The handler talks to Strapi only through the Nuxt global $fetch (stubbed in tests/setup.js) and the two token helpers.
vi.mock('../server/utils/strapi.js', () => ({
  getStrapiToken: vi.fn(() => 'service-token'),
  getStrapiAdminToken: vi.fn(() => 'admin-token')
}))

// Nuxt auto-imports the handler relies on.
globalThis.defineEventHandler = fn => fn
globalThis.getQuery = event => event.query
globalThis.getUserIdFromEvent = event => event.userId

const { default: handler } = await import('../server/api/validate/eventUrl.get.js')

const NOW = new Date('2026-11-14T12:00:00Z')
const SHOW_VIDEO = ['show_courseevent_video', 'true']

// Live Strapi 3 shape for GET /users/:id: the nested function has NO function_parameters (observed 2026-11-14).
const holderOfFunction7 = {
  id: 23969,
  user_roles: [{
    id: 15,
    valid_from: '2026-10-01T09:00:00.000Z',
    valid_to: '2026-12-31T10:00:00.000Z',
    user_right: [{ name: 'See VL video', functions: [{ id: 7, name: 'show_courseevent_restricted_video' }] }]
  }]
}
const userWithoutRights = { id: 23969, user_roles: [] }

// GET /functions returns the function together with its parameters.
const function7 = (...parameters) => ({ id: 7, name: 'show_courseevent_restricted_video', function_parameters: parameters.map(([property, value]) => ({ property, value })) })

const courseEvent1969 = { id: 1969, video_url: 'https://videolevels.com/landing/bc/d0HyUpzCYGp' }

const calls = []
function fakeStrapi ({ user, functions = [], records = {} }) {
  calls.length = 0
  globalThis.$fetch.mockImplementation((url, options = {}) => {
    const { pathname, searchParams } = new URL(url)
    calls.push({ pathname, search: searchParams.toString(), auth: options.headers?.Authorization })
    if (pathname === `/users/${user.id}`) return user
    if (pathname === '/functions') {
      const ids = searchParams.getAll('id_in').map(Number)
      return functions.filter(f => ids.includes(f.id))
    }
    if (records[pathname]) return records[pathname]
    throw Object.assign(new Error(`unexpected Strapi request ${pathname}`), { statusCode: 404 })
  })
}
const asked = pathStart => calls.filter(c => c.pathname.startsWith(pathStart))
const request = (contentType, contentId, userId = 23969) => ({ query: { contentType, contentId: String(contentId) }, userId })

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(NOW)
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('GET /api/validate/eventUrl — the production case', () => {
  test('a role-15 holder gets the course-event video: parameters come from /functions, the /landing/bc/ url is parsed', async () => {
    fakeStrapi({ user: holderOfFunction7, functions: [function7(['show', 'TRUE'], SHOW_VIDEO)], records: { '/course-events/1969': courseEvent1969 } })

    const result = await handler(request('course-event', 1969))

    expect(result).toEqual({ videoProvider: 'videolevels.com', videoId: 'd0HyUpzCYGp' })
    const functionsCall = asked('/functions')[0]
    expect(functionsCall.search).toBe('id_in=7')
    expect(functionsCall.auth).toBe('Bearer admin-token')
  })

  test('the same user is denied while function 7 has only the legacy show / badge parameters', async () => {
    fakeStrapi({ user: holderOfFunction7, functions: [function7(['show', 'TRUE'], ['badge', 'JURY'])], records: { '/course-events/1969': courseEvent1969 } })

    const result = await handler(request('course-event', 1969))

    expect(result).toEqual({ error: 'No permission to view video', code: 403 })
    expect(asked('/course-events')).toHaveLength(0)
  })

  test('a user with no rights is denied without asking Strapi for any function', async () => {
    fakeStrapi({ user: userWithoutRights, functions: [function7(SHOW_VIDEO)], records: { '/course-events/1969': courseEvent1969 } })

    const result = await handler(request('course-event', 1969))

    expect(result).toEqual({ error: 'No permission to view video', code: 403 })
    expect(asked('/functions')).toHaveLength(0)
    expect(asked('/course-events')).toHaveLength(0)
  })
})

describe('GET /api/validate/eventUrl — every content type the pages ask for', () => {
  const entitled = { user: holderOfFunction7, functions: [function7(SHOW_VIDEO)] }

  test.each([
    ['industry-event', '/industry-events/5', { videoUrl: 'https://vimeo.com/123456789' }, { videoProvider: 'vimeo', videoId: '123456789' }],
    ['dis-camp-event', '/dis-camp-events/5', { videoUrl: 'https://videolevels.com/landing/bc/discamp1' }, { videoProvider: 'videolevels.com', videoId: 'discamp1' }],
    ['industry-project', '/industry-projects/5', { clipUrl: 'https://videolevels.com/bc/clip1' }, { videoProvider: 'videolevels.com', videoId: 'clip1' }]
  ])('%s is read from %s with the admin token (the Hunt role may not read it)', async (contentType, path, record, expected) => {
    fakeStrapi({ ...entitled, records: { [path]: { id: 5, ...record } } })

    const result = await handler(request(contentType, 5))

    expect(result).toEqual(expected)
    expect(asked(path)[0].auth).toBe('Bearer admin-token')
  })
})

describe('GET /api/validate/eventUrl — request handling that must keep working', () => {
  test('an unknown content type is a 400', async () => {
    fakeStrapi({ user: holderOfFunction7 })
    await expect(handler(request('film', 1))).rejects.toMatchObject({ statusCode: 400 })
  })

  test('a request without a logged-in user is a 401', async () => {
    fakeStrapi({ user: holderOfFunction7 })
    await expect(handler(request('course-event', 1969, null))).rejects.toMatchObject({ statusCode: 401 })
  })

  test('an entitled user on an event without a video gets a 404 body', async () => {
    fakeStrapi({ user: holderOfFunction7, functions: [function7(SHOW_VIDEO)], records: { '/course-events/1969': { id: 1969, video_url: '' } } })
    expect(await handler(request('course-event', 1969))).toEqual({ error: 'Video URL not found', code: 404 })
  })

  test('an entitled user with a url from an unknown host gets a 500 body', async () => {
    fakeStrapi({ user: holderOfFunction7, functions: [function7(SHOW_VIDEO)], records: { '/course-events/1969': { id: 1969, video_url: 'https://example.com/clip' } } })
    expect(await handler(request('course-event', 1969))).toEqual({ error: 'Failed to parse video URL', code: 500 })
  })
})
