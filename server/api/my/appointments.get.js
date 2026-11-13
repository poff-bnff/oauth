// The appointments (meetings, black carpets, Q&As, screenings, ...) of the logged-in user, with the people in them and the
// meeting programmes the user takes part in. Nothing is stored. Read from Fiona NOW (the XAPI account routes of the user's
// accounts, main + aliases: no publish step and no Strapi person needed; see server/utils/fiona/loginLiveAppointments.js), and
// from the published accreditation card (myAppointments.js and loginAppointments.js) whenever Fiona has no account for any
// of them or a live read fails. Only the user's own accounts are read: no id comes from the browser.
//   GET /api/my/appointments?lang=en|et     (Authorization: Bearer <jwt>)
//   → { ok, programmes[], appointments[], stale?, partial?, error? }
import { hitLimit } from '../../utils/rateLimiter.js'
import { buildPublicationClient, buildXapiClient, buildStrapiGateway } from '../../utils/fionaSync.js'
import { appointmentsForUser } from '../../utils/fiona/loginAppointments.js'
import { appointmentsForLogin } from '../../utils/fiona/loginLiveAppointments.js'
import { appointmentsForPerson } from '../../utils/fiona/myAppointments.js'
import { userCache, personCache, guestbookCache } from '../../utils/fiona/appointmentsCaches.js'
import { createStepTimer } from '../../utils/fiona/stepTimer.js'
import { recordTiming } from '../../utils/fiona/timingLog.js'

const MAX_REQUESTS_PER_MINUTE = 30

// The off switch (2026-11-12: Strapi was overloaded and this route's uncached Strapi reads were a suspect; the reads are cached
// now and the route is back on): set MY_APPOINTMENTS_ENABLED to "false" and the route answers an empty list without calling
// Strapi or Fiona (login is still checked); the my-events page then simply hides the section. Anything else keeps it on.
const isEnabled = () => String(process.env.MY_APPOINTMENTS_ENABLED ?? '').trim().toLowerCase() !== 'false'

// MY_APPOINTMENTS_LIVE set to "false" skips the live read (Fiona XAPI) and answers from the published card only, as before 2026-11-12.
const liveEnabled = () => String(process.env.MY_APPOINTMENTS_LIVE ?? '').trim().toLowerCase() !== 'false'

export default defineEventHandler(async (event) => {
  const userId = getUserIdFromEvent(event)

  if (!isEnabled()) {
    setHeader(event, 'Cache-Control', 'no-store')
    return { ok: true, programmes: [], appointments: [] }
  }

  const limit = hitLimit(`appointments:${userId}`, MAX_REQUESTS_PER_MINUTE, 60 * 1000)
  if (limit.exceeded) {
    setHeader(event, 'Retry-After', limit.retryAfter)
    throw createError({ statusCode: 429, statusMessage: 'Too Many Requests' })
  }

  // the full user is read from Strapi at most once in two minutes (and once at a time) per user
  const timer = createStepTimer()
  const user = await timer.step('user (Strapi)', () => userCache.load(userId, () => getStrapiUser(userId)))
  if (!user) throw createError({ statusCode: 404, statusMessage: 'Not Found' })

  // appointments hold other people's names: the browser must not keep them
  setHeader(event, 'Cache-Control', 'no-store')

  const lang = getQuery(event)?.lang === 'et' ? 'et' : 'en'
  try {
    const gateway = buildStrapiGateway()
    const strapi = { ...gateway, getActiveGuestbookIds: () => guestbookCache.load('active', () => gateway.getActiveGuestbookIds()) }
    const xapi = liveEnabled() ? buildXapiClient() : null // null: no live read, the published-card path answers
    const loadPerson = id => personCache.load(String(id), () => getStrapiPerson(id))
    const result = await appointmentsForLogin({
      timer,
      user,
      xapi,
      strapi,
      lang,
      // the role of the user in a meeting programme is only on the published card (the XAPI does not give it); no Strapi read for profile links
      readCardProgrammes: async ids => (await appointmentsForPerson({
        person: { fiona_person_id: null, fiona_accreditation_id: ids.join(',') },
        publication: buildPublicationClient(),
        strapi: { findPeopleByFionaIds: () => Promise.resolve([]) },
        lang
      })).programmes,
      fallback: () => appointmentsForUser({ user, loadPerson, publication: buildPublicationClient(), xapi, strapi, lang })
    })
    setHeader(event, 'Server-Timing', timer.serverTiming())
    recordTiming({ kind: 'appointments', userId, source: result?.source ?? 'published', ok: result?.ok !== false, ...timer.summary() })
    return result
  } catch (err) {
    recordTiming({ kind: 'appointments', userId, source: 'error', ok: false, ...timer.summary() })
    console.warn(`[my/appointments] user ${userId}: ${err?.message || err}`) // eslint-disable-line no-console
    return { ok: false, error: 'unavailable', programmes: [], appointments: [] }
  }
})
