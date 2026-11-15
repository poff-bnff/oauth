/**
 * The switch that lets the sync link persons to the MeetingProgramme records has three ways in, and a typo in any of them means it can
 * never be turned on: the environment variable (NUXT_SYNC_MEETING_PROGRAMMES -> runtimeConfig.syncMeetingProgrammes -> the sync's
 * config.meetingProgrammes), the test-run flag of POST /api/sync/fiona ("meetingProgrammes": true) and its way through runFionaSync
 * to the sync's `only` options. The behaviour itself is tested in fionaSync.test.js; this keeps the wiring honest.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, it, expect } from 'vitest'

const read = relative => readFileSync(fileURLToPath(new URL(`../${relative}`, import.meta.url)), 'utf8')
const nuxtConfig = read('nuxt.config.ts')
const fionaSync = read('server/utils/fionaSync.js')
const route = read('server/api/sync/fiona.post.js')

describe('meeting programmes switch: wiring', () => {
  it('is an environment switch, NUXT_SYNC_MEETING_PROGRAMMES, off unless it is "true"', () => {
    expect(nuxtConfig).toMatch(/syncMeetingProgrammes: '',\s*\/\/ NUXT_SYNC_MEETING_PROGRAMMES/)
    expect(fionaSync).toContain("meetingProgrammes: String(config.syncMeetingProgrammes).toLowerCase() === 'true'")
  })

  it('can be switched on for a test run: the route reads "meetingProgrammes": true and hands it on to the sync as an option of its own', () => {
    expect(route).toContain('const testMeetingProgrammes = body?.meetingProgrammes === true')
    expect(route).toMatch(/runFionaSync\(\{[^}]*testMeetingProgrammes/)
    expect(fionaSync).toContain('meetingProgrammes: testMeetingProgrammes')
  })

  it('every function that passes the test-run options on carries the new one too', () => {
    const adopt = fionaSync.match(/testAdoptByFilm/g).length
    const meeting = fionaSync.match(/testMeetingProgrammes/g).length
    // testAdoptByFilm appears in the signatures, the pass-through calls and once in `only`; the new option must be in exactly the same places
    expect(meeting).toBe(adopt)
  })

  it('is documented where the other switches are', () => {
    expect(route).toContain('"meetingProgrammes": true')
  })
})
