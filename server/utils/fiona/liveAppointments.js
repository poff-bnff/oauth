/**
 * fiona/liveAppointments.js
 *
 * Reads what Fiona holds NOW for a login - no publish step - from the XAPI: for every account of the login (the main
 * Strapi user and its aliases, the ids Fiona knows as MyPoff accounts) and every active guestbook, the appointments
 * (with the people in them) and the meeting programme participations, merged. See xapiAppointments.js for the shapes.
 *
 * A 404 or a 400 only means "Fiona has no account under that id" (an alias, or a login that never got an accreditation:
 * Fiona answers 400 for an unknown external id, measured 2026-11-12); `unknownAccounts` counts such ids so that a systematic
 * problem cannot hide. Any other failure makes the answer `ok: false`, so the caller can fall back to the published card
 * instead of showing a half answer as complete.
 */
import { normalizeXapiAppointments, normalizeXapiProgrammes } from './xapiAppointments.js'
import { compareByTime } from './appointments.js'

const PROVIDER = 'MyPoff'

const asList = value => (Array.isArray(value) ? value : [])
const unique = list => [...new Set(list)]

const NO_ACCOUNT_STATUSES = new Set([400, 404])
const isNoAccount = err => NO_ACCOUNT_STATUSES.has(err?.statusCode ?? err?.status ?? err?.response?.status)

const usable = value => value !== null && value !== undefined && String(value).trim() !== '' && Number(value) !== 0

/**
 * @param {object} options
 * @param {{ getRaw: (path: string) => Promise<any> }} options.xapi
 * @param {Array<string|number>} options.userIds        the Strapi user ids of the login (main + aliases)
 * @param {string[]} options.guestbookIds               the active guestbooks
 * @param {string} [options.lang]
 * @param {object[]} [options.publishedProgrammes]       programmes of the published card, for the role in each
 * @returns {Promise<{ ok: boolean, found: boolean, accreditationIds: string[], appointments: object[], programmes: object[], errors: Array<{ what: string, error: string }>, unknownAccounts: number }>}
 */
export async function readLiveAppointments ({ xapi, userIds = [], guestbookIds = [], lang = 'en', publishedProgrammes = [] } = {}) {
  const ids = unique(asList(userIds).filter(usable).map(id => String(id).trim()))
  const guestbooks = unique(asList(guestbookIds).filter(usable).map(id => String(id).trim()))

  const attempts = []
  for (const guestbook of guestbooks) {
    for (const id of ids) {
      const base = `/account/${PROVIDER}/${encodeURIComponent(id)}/guestbook/${encodeURIComponent(guestbook)}`
      attempts.push({ what: 'appointments', id, path: `${base}/appointments?includeAttendees=true` })
      attempts.push({ what: 'meetingprogramparticipations', id, path: `${base}/meetingprogramparticipations` })
    }
  }

  const outcomes = await Promise.all(attempts.map(async ({ what, id, path }) => {
    try {
      return { what, id, raw: await xapi.getRaw(path) }
    } catch (err) {
      return isNoAccount(err) ? { what, id, noAccount: true } : { what, id, error: String(err?.message || err) }
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

  // ids for which every read said "no account" (an id whose reads partly failed for another reason is not "unknown")
  const unknownAccounts = ids.filter((id) => {
    const reads = outcomes.filter(outcome => outcome.id === id)
    return reads.length > 0 && reads.every(outcome => outcome.noAccount === true)
  }).length

  return {
    ok: errors.length === 0,
    found,
    accreditationIds,
    appointments: [...appointmentsById.values(), ...loose].sort(compareByTime),
    programmes,
    errors,
    unknownAccounts
  }
}
