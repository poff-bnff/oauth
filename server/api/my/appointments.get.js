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

const MAX_REQUESTS_PER_MINUTE = 30

// Switched OFF unless MY_APPOINTMENTS_ENABLED is exactly "true" (2026-11-12: Strapi was overloaded and this route's uncached
// Strapi reads - the full user, the full person, people by Fiona id, the active guestbooks - were a suspect). While it is off
// the route answers an empty list without calling Strapi or Fiona, and the my-events page simply hides the section.
const isEnabled = () => process.env.MY_APPOINTMENTS_ENABLED === 'true'

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

  const user = await getStrapiUser(userId)
  if (!user) throw createError({ statusCode: 404, statusMessage: 'Not Found' })

  // appointments hold other people's names: the browser must not keep them
  setHeader(event, 'Cache-Control', 'no-store')

  const lang = getQuery(event)?.lang === 'et' ? 'et' : 'en'
  try {
    return await appointmentsForUser({
      user,
      loadPerson: getStrapiPerson,
      publication: buildPublicationClient(),
      xapi: buildXapiClient(),
      strapi: buildStrapiGateway(),
      lang
    })
  } catch (err) {
    console.warn(`[my/appointments] user ${userId}: ${err?.message || err}`) // eslint-disable-line no-console
    return { ok: false, error: 'unavailable', programmes: [], appointments: [] }
  }
})
