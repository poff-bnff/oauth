/**
 * fiona/xapiAppointments.js
 *
 * The LIVE appointments and meeting programmes of a login, read from the Fiona XAPI, shaped exactly like the ones read from
 * the published accreditation card (see appointments.js) so the page needs no change. No publish step is needed for these: they
 * are what Fiona holds now (the published card is a snapshot from the last (re)publish).
 *
 *   GET /account/MyPoff/{userId}/guestbook/{guestbookId}/appointments?includeAttendees=true
 *     → { Accreditation { Id, Description }, AccreditationStatus { Key }, Appointments[{ Id, AppointmentType { Description, Id },
 *         StartsOn, EndsOn, Subject, IsOnline, Location { Description, Id }, Table, InternalNotes, Members[{ FullName, CompanyName,
 *         Role { Key, Translations[{ Language, Text, Abbreviation }] } }] }] }
 *   GET /account/MyPoff/{userId}/guestbook/{guestbookId}/meetingprogramparticipations
 *     → { Schedules[{ Id, Name, MeetingPrograms[{ Id, Name, MeetingRequestFormsOpensOn, MeetingRequestFormsClosesOn }] }] }
 *
 * Differences from the card, handled here: XAPI members have no person id (so the member that is the login is recognised by
 * the name of the accreditation, and nobody gets a profile link); the appointment type has a description but no key (the key is
 * made from it); the programme participation has no role (taken from the published card when it names the same programme).
 * `InternalNotes` is never passed on. Pure: no network.
 */
import { normalizeAppointments } from './appointments.js'

const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const asList = value => (Array.isArray(value) ? value : [])
const text = value => (typeof value === 'string' || typeof value === 'number' ? String(value).trim() : '')
const orNull = value => text(value) || null

const NOT_SET_TYPES = new Set(['', '-', 'not set', 'not-set'])

const nameKey = value => text(value).toLowerCase().replace(/\s+/g, ' ')
const slug = value => text(value).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')

/** A time with any UTC offset as UTC ISO, like the published card; null when it cannot be read. */
function utcIso (value) {
  const raw = text(value)
  if (!raw) return null
  const time = Date.parse(raw)
  return Number.isNaN(time) ? null : new Date(time).toISOString()
}

/** The role of a member in the card's shape ({ key, translations[{ language, text, abbreviation }] }). */
function cardRole (role) {
  if (!isRecord(role)) return undefined
  return {
    key: role.Key,
    translations: asList(role.Translations).filter(isRecord).map(item => ({ language: item.Language, text: item.Text, abbreviation: item.Abbreviation }))
  }
}

function cardAppointment (raw, lang, myName, myAccreditationId) {
  const typeText = text(raw.AppointmentType?.Description)
  const notSet = NOT_SET_TYPES.has(typeText.toLowerCase())
  const location = isRecord(raw.Location) ? raw.Location : null
  return {
    id: raw.Id,
    appointmentType: { key: notSet ? 'not-set' : (slug(typeText) || 'not-set'), translations: [{ language: lang, text: typeText }] },
    startsOn: utcIso(raw.StartsOn),
    endsOn: utcIso(raw.EndsOn),
    subject: raw.Subject,
    isOnline: raw.IsOnline === true,
    location: location ? { description: location.Description } : undefined,
    table: raw.Table,
    members: asList(raw.Members).filter(isRecord).map(member => ({
      personFullName: member.FullName,
      role: cardRole(member.Role),
      accreditationId: myName && nameKey(member.FullName) === myName ? myAccreditationId : undefined
    }))
  }
}

/**
 * @param {object|null} answer   the raw answer of .../appointments?includeAttendees=true
 * @param {{ lang?: string }} [options]
 * @returns {{ accreditation: { id: string|null, description: string|null, status: string|null }|null, appointments: object[] }}
 */
export function normalizeXapiAppointments (answer, { lang = 'en' } = {}) {
  const source = isRecord(answer) ? answer : {}
  const accreditation = isRecord(source.Accreditation)
    ? { id: orNull(source.Accreditation.Id), description: orNull(source.Accreditation.Description), status: orNull(source.AccreditationStatus?.Key) }
    : null

  const myName = accreditation?.description ? nameKey(accreditation.description) : ''
  const appointments = normalizeAppointments({
    appointments: asList(source.Appointments).filter(isRecord).map(raw => cardAppointment(raw, lang, myName, accreditation?.id))
  }, { lang, myAccreditationIds: accreditation?.id ? [accreditation.id] : [] }).appointments

  return { accreditation, appointments }
}

/**
 * @param {object|null} answer   the raw answer of .../meetingprogramparticipations
 * @param {{ publishedProgrammes?: object[] }} [options]   programmes read from the published card, for the role of the login in each
 * @returns {object[]} [{ id, name, schedule, role, requestsOpenOn, requestsCloseOn }]
 */
export function normalizeXapiProgrammes (answer, { publishedProgrammes = [] } = {}) {
  const programmes = []
  const seen = new Set()
  for (const schedule of asList(isRecord(answer) ? answer.Schedules : null).filter(isRecord)) {
    for (const programme of asList(schedule.MeetingPrograms).filter(isRecord)) {
      const name = text(programme.Name)
      if (!name) continue
      const id = orNull(programme.Id)
      const key = id ?? name
      if (seen.has(key)) continue
      seen.add(key)
      const published = asList(publishedProgrammes).find(item => id && item?.id === id)
      programmes.push({
        id,
        name,
        schedule: orNull(schedule.Name),
        role: published?.role ?? null,
        requestsOpenOn: utcIso(programme.MeetingRequestFormsOpensOn),
        requestsCloseOn: utcIso(programme.MeetingRequestFormsClosesOn)
      })
    }
  }
  return programmes
}
