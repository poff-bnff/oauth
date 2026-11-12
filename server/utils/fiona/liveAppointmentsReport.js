/**
 * fiona/liveAppointmentsReport.js
 *
 * Read-only probe (mode `liveAppointments` with `userIds` of POST /api/sync/fiona): for a few logins, what Fiona holds NOW
 * (the XAPI: no publish step) against what the published accreditation card says, appointment by appointment, with the time
 * each read took (the first real measure of how long Fiona takes). The e-mails and names of the login are not in the answer;
 * the two values of a differing field only when `showValues` is set.
 */
import { loginIdentity } from './loginAppointments.js'
import { readLiveAppointments } from './liveAppointments.js'
import { compareAppointmentLists } from './appointmentsCompare.js'

const MAX_USERS = 5

const asList = value => (Array.isArray(value) ? value : [])
const programmeLine = programme => ({ name: programme.name, role: programme.role?.text ?? null })

/**
 * @param {object} options
 * @param {number[]} options.userIds                      Strapi user ids (any account of a login; the main account is used), at most five
 * @param {Function} options.loadUser                     id → the Strapi user
 * @param {Function} options.loadPerson                   id → the Strapi person
 * @param {{ getRaw: Function }} options.xapi
 * @param {{ getActiveGuestbookIds: Function }} options.strapi
 * @param {Function} options.readPublished                ({ user }) → the published answer { ok, programmes, appointments } (fresh caches)
 * @param {boolean} [options.showValues]
 */
export async function liveAppointmentsReport ({ userIds = [], showValues = false, loadUser, loadPerson, xapi, strapi, readPublished, lang = 'en', now = Date.now } = {}) {
  const users = []
  const skipped = []

  for (const userId of asList(userIds).map(Number).filter(Number.isFinite).slice(0, MAX_USERS)) {
    const user = await loadUser(userId)
    if (!user) { skipped.push({ userId, reason: 'no such user' }); continue }

    const identity = await loginIdentity(user, { loadPerson })
    const guestbookIds = asList(await strapi.getActiveGuestbookIds()).map(String)

    const publishedStart = now()
    let publishedAnswer = null
    let published
    try {
      publishedAnswer = await readPublished({ user })
      published = { ok: publishedAnswer?.ok !== false, appointments: asList(publishedAnswer?.appointments).length, programmes: asList(publishedAnswer?.programmes).map(programmeLine), ms: now() - publishedStart }
    } catch (err) {
      published = { ok: false, error: String(err?.message || err), ms: now() - publishedStart }
    }

    const liveStart = now()
    const live = await readLiveAppointments({ xapi, userIds: identity.userIds, guestbookIds, lang, publishedProgrammes: asList(publishedAnswer?.programmes) })
    const liveSummary = {
      ok: live.ok,
      found: live.found,
      accreditations: live.accreditationIds.length,
      appointments: live.appointments.length,
      programmes: live.programmes.map(programmeLine),
      errors: live.errors,
      unknownAccounts: live.unknownAccounts,
      ms: now() - liveStart
    }

    const comparison = live.ok && published.ok ? compareAppointmentLists(live.appointments, asList(publishedAnswer?.appointments), { showValues }) : null
    users.push({ userId, accounts: asList(identity.userIds).length, guestbooks: guestbookIds.length, live: liveSummary, published, comparison })
  }

  return { users, skipped }
}
