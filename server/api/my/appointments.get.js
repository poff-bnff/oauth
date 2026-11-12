// The appointments (meetings, black carpets, Q&As, screenings, ...) of the logged-in user, read live from Fiona,
// with the people in them and the meeting programmes the user takes part in. Nothing is stored; see
// server/utils/fiona/myAppointments.js and loginAppointments.js. Only the user's own accreditation(s) are read: no id
// comes from the browser. The accreditation is the one on the user's Strapi person (persons the Fiona sync manages);
// for a login whose person has none (staff, organisers) it is found in Fiona by the login's name and accepted only
// when Fiona's own record proves it is that login (e-mail, MyPoff user id).
//   GET /api/my/appointments?lang=en|et     (Authorization: Bearer <jwt>)
//   → { ok, programmes[], appointments[], stale?, partial?, error? }
import { hitLimit } from '../../utils/rateLimiter.js'
import { buildPublicationClient, buildXapiClient, buildStrapiGateway } from '../../utils/fionaSync.js'
import { appointmentsForUser } from '../../utils/fiona/loginAppointments.js'
import { userCache, personCache, guestbookCache } from '../../utils/fiona/appointmentsCaches.js'

const MAX_REQUESTS_PER_MINUTE = 30

// The off switch (2026-11-12: Strapi was overloaded and this route's uncached Strapi reads were a suspect; the reads are cached
// now and the route is back on): set MY_APPOINTMENTS_ENABLED to "false" and the route answers an empty list without calling
// Strapi or Fiona (login is still checked); the my-events page then simply hides the section. Anything else keeps it on.
const isEnabled = () => String(process.env.MY_APPOINTMENTS_ENABLED ?? '').trim().toLowerCase() !== 'false'

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
  const user = await userCache.load(userId, () => getStrapiUser(userId))
  if (!user) throw createError({ statusCode: 404, statusMessage: 'Not Found' })

  // appointments hold other people's names: the browser must not keep them
  setHeader(event, 'Cache-Control', 'no-store')

  const lang = getQuery(event)?.lang === 'et' ? 'et' : 'en'
  try {
    const gateway = buildStrapiGateway()
    return await appointmentsForUser({
      user,
      loadPerson: id => personCache.load(String(id), () => getStrapiPerson(id)),
      publication: buildPublicationClient(),
      xapi: buildXapiClient(),
      strapi: { ...gateway, getActiveGuestbookIds: () => guestbookCache.load('active', () => gateway.getActiveGuestbookIds()) },
      lang
    })
  } catch (err) {
    console.warn(`[my/appointments] user ${userId}: ${err?.message || err}`) // eslint-disable-line no-console
    return { ok: false, error: 'unavailable', programmes: [], appointments: [] }
  }
})
