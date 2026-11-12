/**
 * fiona/liveAppointments.js
 *
 * Reads what Fiona holds NOW for a login - no publish step - from the XAPI: for every account of the login (the main
 * Strapi user and its aliases, the ids Fiona knows as MyPoff accounts) and every active guestbook, the appointments
 * (with the people in them) and the meeting programme participations, merged. See xapiAppointments.js for the shapes.
 *
 * A 404 only means "Fiona has no account under that id" (an alias, or a login that never got an accreditation). Any other
 * failure makes the answer `ok: false`, so the caller can fall back to the published card instead of showing a half
 * answer as complete.
 */
import { normalizeXapiAppointments, normalizeXapiProgrammes } from './xapiAppointments.js'
import { compareByTime } from './appointments.js'

const PROVIDER = 'MyPoff'

const asList = value => (Array.isArray(value) ? value : [])
const unique = list => [...new Set(list)]

const isNotFound = err => err?.statusCode === 404 || err?.status === 404 || err?.response?.status === 404

const usable = value => value !== null && value !== undefined && String(value).trim() !== '' && Number(value) !== 0

/**
 * @param {object} options
 * @param {{ getRaw: (path: string) => Promise<any> }} options.xapi
 * @param {Array<string|number>} options.userIds        the Strapi user ids of the login (main + aliases)
 * @param {string[]} options.guestbookIds               the active guestbooks
 * @param {string} [options.lang]
 * @param {object[]} [options.publishedProgrammes]       programmes of the published card, for the role in each
 * @returns {Promise<{ ok: boolean, found: boolean, accreditationIds: string[], appointments: object[], programmes: object[], errors: Array<{ what: string, error: string }> }>}
 */
export async function readLiveAppointments ({ xapi, userIds = [], guestbookIds = [], lang = 'en', publishedProgrammes = [] } = {}) {
  const ids = unique(asList(userIds).filter(usable).map(id => String(id).trim()))
  const guestbooks = unique(asList(guestbookIds).filter(usable).map(id => String(id).trim()))

  const attempts = []
  for (const guestbook of guestbooks) {
    for (const id of ids) {
      const base = `/account/${PROVIDER}/${encodeURIComponent(id)}/guestbook/${encodeURIComponent(guestbook)}`
      attempts.push({ what: 'appointments', path: `${base}/appointments?includeAttendees=true` })
      attempts.push({ what: 'meetingprogramparticipations', path: `${base}/meetingprogramparticipations` })
    }
  }

  const outcomes = await Promise.all(attempts.map(async ({ what, path }) => {
    try {
      return { what, raw: await xapi.getRaw(path) }
    } catch (err) {
      return isNotFound(err) ? { what, notFound: true } : { what, error: String(err?.message || err) }
    }
  }))

  const errors = outcomes.filter(outcome => outcome.error !== undefined).map(({ what, error }) => ({ what, error }))
  const accreditationIds = []
  const appointmentsById = new Map()
  const loose = []
  const programmes = []
  const seenProgrammes = new Set()
  let found = false

  for (const outcome of outcomes) {
    if (outcome.raw === undefined) continue
    if (outcome.what === 'appointments') {
      const { accreditation, appointments } = normalizeXapiAppointments(outcome.raw, { lang })
      if (accreditation) found = true
      if (accreditation?.id && !accreditationIds.includes(accreditation.id)) accreditationIds.push(accreditation.id)
      for (const appointment of appointments) {
        if (appointment.id === null) loose.push(appointment)
        else if (!appointmentsById.has(appointment.id)) appointmentsById.set(appointment.id, appointment)
      }
    } else {
      if (outcome.raw?.Accreditation) found = true
      for (const programme of normalizeXapiProgrammes(outcome.raw, { publishedProgrammes })) {
        const key = programme.id ?? programme.name
        if (seenProgrammes.has(key)) continue
        seenProgrammes.add(key)
        programmes.push(programme)
      }
    }
  }

  return {
    ok: errors.length === 0,
    found,
    accreditationIds,
    appointments: [...appointmentsById.values(), ...loose].sort(compareByTime),
    programmes,
    errors
  }
}
