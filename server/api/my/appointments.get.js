// The appointments (meetings, black carpets, Q&As, screenings, ...) of the logged-in user, read live from Fiona,
// with the people in them and the meeting programmes the user takes part in. Nothing is stored; see
// server/utils/fiona/myAppointments.js. Only the user's own accreditation(s) are read: no id comes from the browser.
//   GET /api/my/appointments?lang=en|et     (Authorization: Bearer <jwt>)
//   → { ok, programmes[], appointments[], stale?, partial?, error? }
import { hitLimit } from '../../utils/rateLimiter.js'
import { buildPublicationClient, buildStrapiGateway } from '../../utils/fionaSync.js'
import { appointmentsForPerson } from '../../utils/fiona/myAppointments.js'

const MAX_REQUESTS_PER_MINUTE = 30
const EMPTY = () => ({ ok: true, programmes: [], appointments: [] })

export default defineEventHandler(async (event) => {
  const userId = getUserIdFromEvent(event)

  const limit = hitLimit(`appointments:${userId}`, MAX_REQUESTS_PER_MINUTE, 60 * 1000)
  if (limit.exceeded) {
    setHeader(event, 'Retry-After', limit.retryAfter)
    throw createError({ statusCode: 429, statusMessage: 'Too Many Requests' })
  }

  const user = await getStrapiUser(userId)
  if (!user) throw createError({ statusCode: 404, statusMessage: 'Not Found' })

  // appointments hold other people's names: the browser must not keep them
  setHeader(event, 'Cache-Control', 'no-store')

  if (!user.person || !user.person.id) return EMPTY()

  const lang = getQuery(event)?.lang === 'et' ? 'et' : 'en'
  try {
    const person = await getStrapiPerson(user.person.id)
    return await appointmentsForPerson({ person, publication: buildPublicationClient(), strapi: buildStrapiGateway(), lang })
  } catch (err) {
    console.warn(`[my/appointments] user ${userId}: ${err?.message || err}`) // eslint-disable-line no-console
    return { ok: false, error: 'unavailable', programmes: [], appointments: [] }
  }
})
