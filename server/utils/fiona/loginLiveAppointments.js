/**
 * fiona/loginLiveAppointments.js
 *
 * What GET /api/my/appointments answers: the appointments Fiona holds NOW for the logged-in user's accounts (the main Strapi
 * user and its aliases, read from the XAPI as MyPoff accounts: no publish step, and no Strapi person is needed), and the
 * published-card path (`fallback`: appointmentsForUser) whenever Fiona has no account for any of them or a read fails.
 *
 * 2026-11-12: a login whose Strapi user had no person (Laura) could not be matched by the published-card path at all - it
 * searches by the names on the persons of the login - and saw nothing, although Fiona held her appointment under her MyPoff id.
 *
 * The XAPI gives members no person id, so nobody gets a profile link (slug: null). The role of the user in a meeting programme
 * is not in the XAPI answer; it is taken from the published card when that names the same programme, else shown as none.
 * The read is cached for a minute per login. The ids come from the logged-in user only, never from the browser.
 */
import { readLiveAppointments } from './liveAppointments.js'
import { createLoaderCache } from './loaderCache.js'
import { noopTimer } from './stepTimer.js'

export const LIVE_TTL_MS = 60 * 1000
const defaultCache = createLoaderCache({ ttlMs: LIVE_TTL_MS, maxEntries: 1000 })

const asList = value => (Array.isArray(value) ? value : [])
const usable = value => value !== null && value !== undefined && String(value).trim() !== '' && Number(value) !== 0

const loginUserIds = user => [...new Set([user?.id, ...asList(user?.aliasUsers).map(alias => alias?.id)].filter(usable).map(String))]

/** An error message without the URL (it holds the id of the account): "[GET] "https://…": 504 Gateway Time-out" → "504 Gateway Time-out". */
const shortError = message => String(message ?? '').replace(/^.*?":\s*/, '')

function attachRoles (programmes, published) {
  const roles = new Map(asList(published).filter(item => item?.id && item.role).map(item => [String(item.id), item.role]))
  return programmes.map(programme => ({ ...programme, role: programme.role ?? roles.get(String(programme.id)) ?? null }))
}

/**
 * @param {object} options
 * @param {object} options.user                 the logged-in Strapi user: id, aliasUsers[{ id }]
 * @param {{ getRaw: Function }|null} options.xapi
 * @param {{ getActiveGuestbookIds: Function }} options.strapi
 * @param {string} [options.lang]
 * @param {(accreditationIds: string[]) => Promise<object[]>} options.readCardProgrammes   the programmes of the published cards (for the roles)
 * @param {() => Promise<object>} options.fallback   the published-card path
 * @returns {Promise<{ ok: boolean, source?: 'live', programmes: object[], appointments: object[] }>}
 */
export async function appointmentsForLogin ({ user, xapi, strapi, lang = 'en', readCardProgrammes, fallback: published, cache = defaultCache, timer = noopTimer, log = console } = {}) {
  const fallback = () => timer.step('fallback (published card path)', published)
  const userIds = loginUserIds(user)
  if (!xapi || !userIds.length) return await fallback()

  let live
  try {
    const guestbookIds = asList(await timer.step('guestbooks', () => strapi.getActiveGuestbookIds())).map(String)
    if (!guestbookIds.length) return await fallback()
    live = await timer.step('live read (Fiona XAPI)', () => cache.load(`${lang}|${userIds.join(',')}|${guestbookIds.join(',')}`, () => readLiveAppointments({ xapi, userIds, guestbookIds, lang })))
  } catch (err) {
    log.warn?.(`[fiona appointments] live read failed, using the published card: ${shortError(err?.message || err)}`)
    return await fallback()
  }
  timer.detail('liveCalls', live.calls) // as measured when the read ran (a cached answer repeats them)
  if (!live.ok) {
    log.warn?.(`[fiona appointments] live read failed, using the published card: ${live.errors.map(error => `${error.what} ${shortError(error.error)}`).join('; ')}`)
    return await fallback()
  }
  if (!live.found) return await fallback()

  let cardProgrammes = []
  if (live.programmes.length) {
    try {
      cardProgrammes = await timer.step('programme roles (Fiona card)', () => readCardProgrammes(live.accreditationIds))
    } catch (err) {
      log.warn?.(`[fiona appointments] programme roles not read from the published card: ${shortError(err?.message || err)}`)
    }
  }

  return {
    ok: true,
    source: 'live',
    programmes: attachRoles(live.programmes, cardProgrammes),
    appointments: live.appointments.map(appointment => ({
      ...appointment,
      members: appointment.members.map(member => ({ name: member.name, role: member.role, isMe: member.isMe, slug: null }))
    }))
  }
}
