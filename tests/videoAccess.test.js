import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import {
  ALLOWED_CONTENT_TYPES,
  hasVideoPermission,
  parseVideoUrl,
  pickVideoUrl,
  userFunctionIds
} from '../server/utils/videoAccess.js'

// Shapes below are copied from what live Strapi 3.6.10 really returns for GET /users/:id (observed 2026-11-14 through
// /api/me): the function objects nested in user_roles[].user_right[].functions[] carry NO function_parameters.
const role = (id, functions, { from = '2026-10-01T09:00:00.000Z', to = '2026-12-31T10:00:00.000Z' } = {}) => ({
  id,
  valid_from: from,
  valid_to: to,
  user_right: [{ name: `right of role ${id}`, functions: functions.map(fid => ({ id: fid, name: `function ${fid}` })) }]
})
const userWith = (...roles) => ({ id: 23969, user_roles: roles })

// What GET /functions returns on its own: the function WITH its function_parameters component.
const fn = (id, ...parameters) => ({ id, name: `function ${id}`, function_parameters: parameters.map(([property, value]) => ({ property, value })) })
const SHOW_VIDEO = ['show_courseevent_video', 'true']

describe('parseVideoUrl', () => {
  test('reads the id from the /landing/bc/ shape every course event uses', () => {
    expect(parseVideoUrl('https://videolevels.com/landing/bc/d0HyUpzCYGp')).toEqual({ videoProvider: 'videolevels.com', videoId: 'd0HyUpzCYGp' })
  })
  test('still reads the plain /bc/ shape', () => {
    expect(parseVideoUrl('https://videolevels.com/bc/abc123/extra')).toEqual({ videoProvider: 'videolevels.com', videoId: 'abc123' })
  })
  test('drops a leading www from the provider', () => {
    expect(parseVideoUrl('https://www.videolevels.com/landing/bc/xyz')).toEqual({ videoProvider: 'videolevels.com', videoId: 'xyz' })
  })
  test('rejects another host that merely mentions videolevels.com', () => {
    expect(parseVideoUrl('https://evil.example/landing/bc/x?from=videolevels.com')).toBeNull()
  })
  test('rejects a videolevels url that has no /bc/ id', () => {
    expect(parseVideoUrl('https://videolevels.com/landing/')).toBeNull()
  })
  test('reads vimeo and youtube ids', () => {
    expect(parseVideoUrl('https://vimeo.com/123456789')).toEqual({ videoProvider: 'vimeo', videoId: '123456789' })
    expect(parseVideoUrl('https://www.youtube.com/watch?v=dQw4w9WgXcQ')).toEqual({ videoProvider: 'youtube', videoId: 'dQw4w9WgXcQ' })
  })
  test('returns null for empty or unparseable input', () => {
    expect(parseVideoUrl('')).toBeNull()
    expect(parseVideoUrl(null)).toBeNull()
    expect(parseVideoUrl('not a url')).toBeNull()
  })
})

describe('pickVideoUrl', () => {
  test('takes the field each content type really has', () => {
    expect(pickVideoUrl('course-event', { video_url: 'a' })).toBe('a')
    expect(pickVideoUrl('dis-camp-event', { videoUrl: 'b' })).toBe('b')
    expect(pickVideoUrl('industry-event', { videoUrl: 'c' })).toBe('c')
    expect(pickVideoUrl('industry-project', { clipUrl: 'd' })).toBe('d')
  })
  test('returns null when the record has no video', () => {
    expect(pickVideoUrl('course-event', {})).toBeNull()
    expect(pickVideoUrl('course-event', null)).toBeNull()
  })
})

test('industry-event is an allowed content type next to the other three', () => {
  expect([...ALLOWED_CONTENT_TYPES].sort()).toEqual(['course-event', 'dis-camp-event', 'industry-event', 'industry-project'])
})

describe('userFunctionIds', () => {
  beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-11-14T12:00:00Z')) })
  afterEach(() => { vi.useRealTimers() })

  test('lists each function id once, across all currently valid roles', () => {
    const user = userWith(role(8, [1, 7]), role(15, [7]), role(12, [9]))
    expect(userFunctionIds(user).sort((a, b) => a - b)).toEqual([1, 7, 9])
  })
  test('ignores roles that are expired or not yet valid', () => {
    const user = userWith(
      role(5, [1], { from: '2022-10-01T09:00:00.000Z', to: '2022-12-31T10:00:00.000Z' }),
      role(6, [2], { from: '2027-01-01T00:00:00.000Z', to: '2027-12-31T00:00:00.000Z' }),
      role(15, [7])
    )
    expect(userFunctionIds(user)).toEqual([7])
  })
  test('treats a role without dates as always valid', () => {
    expect(userFunctionIds(userWith(role(13, [4], { from: null, to: null })))).toEqual([4])
  })
  test('copes with a user that has no roles or rights', () => {
    expect(userFunctionIds({ id: 1 })).toEqual([])
    expect(userFunctionIds({ id: 1, user_roles: [{ id: 3, valid_from: null, valid_to: null }] })).toEqual([])
  })
})

describe('hasVideoPermission', () => {
  beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-11-14T12:00:00Z')) })
  afterEach(() => { vi.useRealTimers() })

  test('grants a valid role whose function carries show_courseevent_video = true (parameters come from /functions)', () => {
    expect(hasVideoPermission(userWith(role(15, [7])), [fn(7, ['show', 'TRUE'], SHOW_VIDEO)])).toBe(true)
  })
  test('denies when the function has only the legacy show / badge parameters', () => {
    expect(hasVideoPermission(userWith(role(15, [7])), [fn(7, ['show', 'TRUE'], ['badge', 'JURY'])])).toBe(false)
  })
  test('denies when the parameter is there but not true', () => {
    expect(hasVideoPermission(userWith(role(15, [7])), [fn(7, ['show_courseevent_video', 'false'])])).toBe(false)
  })
  test('accepts the value in any case, since Strapi editors type TRUE as well', () => {
    expect(hasVideoPermission(userWith(role(15, [7])), [fn(7, ['show_courseevent_video', 'TRUE'])])).toBe(true)
  })
  test('denies when the right is on a function the user does not hold', () => {
    expect(hasVideoPermission(userWith(role(15, [1])), [fn(1, ['show', 'TRUE']), fn(7, SHOW_VIDEO)])).toBe(false)
  })
  test('denies an expired role even though its function has the parameter', () => {
    const expired = role(5, [7], { from: '2022-10-01T09:00:00.000Z', to: '2022-12-31T10:00:00.000Z' })
    expect(hasVideoPermission(userWith(expired), [fn(7, SHOW_VIDEO)])).toBe(false)
  })
  test('denies when the functions list could not supply parameters at all', () => {
    expect(hasVideoPermission(userWith(role(15, [7])), [{ id: 7, name: 'function 7' }])).toBe(false)
    expect(hasVideoPermission(userWith(role(15, [7])), [])).toBe(false)
    expect(hasVideoPermission(userWith(role(15, [7])), undefined)).toBe(false)
  })
})
