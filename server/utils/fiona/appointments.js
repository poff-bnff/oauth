/**
 * fiona/appointments.js
 *
 * The appointments of a person as the festival site shows them to that person: from the raw Publication API
 * accreditation card (`GET /accreditations/{id}`) it takes `appointments[]` (meetings, black carpets, Q&As,
 * screenings, interviews, ...) and `meetingProgramParticipations[]` (Film Market, Series Market, ...), and
 * passes on only what the page displays. Pure: no network, no Strapi.
 *
 * Raw shapes (read from real cards with the `fields` diagnostic, 2026-11-11):
 *   appointment   { id, appointmentType { key, translations[{ language, text, abbreviation }] }, startsOn, endsOn (UTC ISO),
 *                   subject, isOnline, location { id, description, isOnline, abbreviation }, showId, filmId, table,
 *                   publicationNotes, members[{ id, personId, accreditationId, personFullName, role { key, translations } }] }
 *   participation { hideForMeetingRequests, meetingProgram { id, description, schedule { id, description } }, role { key, translations } }
 * `table` was null in every sample, so its shape is a guess: text, or an object with a description / name / number.
 */

const NOT_SET = 'not-set'

const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const asList = value => (Array.isArray(value) ? value : [])
const text = value => (typeof value === 'string' || typeof value === 'number' ? String(value).trim() : '')
const orNull = value => text(value) || null

/** The translation in the wanted language, else English, else the first one. */
function pickTranslation (translations, lang) {
  const list = asList(translations).filter(isRecord)
  return list.find(item => item.language === lang) ?? list.find(item => item.language === 'en') ?? list[0] ?? null
}

/** { key, text } of a lookup with translations (a role), or null when there is nothing to show ("not set" is shown as "-" in Fiona). */
function lookup (raw, lang) {
  if (!isRecord(raw)) return null
  const key = text(raw.key)
  if (key === NOT_SET) return null
  const label = text(pickTranslation(raw.translations, lang)?.text)
  if (!key && !label) return null
  return { key, text: label }
}

function appointmentType (raw, lang) {
  if (!isRecord(raw)) return null
  const key = text(raw.key)
  if (!key || key === NOT_SET) return null
  const translation = pickTranslation(raw.translations, lang)
  return { key, text: text(translation?.text), abbreviation: orNull(translation?.abbreviation) }
}

function tableText (raw) {
  if (isRecord(raw)) return orNull(raw.description) ?? orNull(raw.name) ?? orNull(raw.number)
  return orNull(raw)
}

function normalizeMember (raw, lang, mine) {
  if (!isRecord(raw)) return null
  const name = text(raw.personFullName)
  if (!name) return null
  const personId = orNull(raw.personId)
  const accreditationId = orNull(raw.accreditationId)
  return {
    id: orNull(raw.id),
    name,
    role: lookup(raw.role, lang),
    personId,
    isMe: Boolean((personId && personId === mine.personId) || (accreditationId && mine.accreditationIds.has(accreditationId)))
  }
}

function normalizeAppointment (raw, lang, mine) {
  const location = isRecord(raw.location) ? raw.location : null
  return {
    id: orNull(raw.id),
    type: appointmentType(raw.appointmentType, lang),
    startsOn: orNull(raw.startsOn),
    endsOn: orNull(raw.endsOn),
    subject: text(raw.subject),
    location: orNull(location?.description),
    isOnline: raw.isOnline === true || location?.isOnline === true,
    table: tableText(raw.table),
    notes: orNull(raw.publicationNotes),
    members: asList(raw.members).map(member => normalizeMember(member, lang, mine)).filter(Boolean)
  }
}

function normalizeProgramme (raw, lang) {
  const programme = isRecord(raw?.meetingProgram) ? raw.meetingProgram : null
  const name = text(programme?.description)
  if (!name) return null
  return {
    id: orNull(programme.id),
    name,
    schedule: orNull(programme.schedule?.description),
    role: lookup(raw.role, lang)
  }
}

/** Sort order of appointments: start time, then end time; those without a time last. */
export const compareByTime = (a, b) => {
  const start = String(a.startsOn ?? '￿').localeCompare(String(b.startsOn ?? '￿'))
  return start || String(a.endsOn ?? '￿').localeCompare(String(b.endsOn ?? '￿'))
}

/**
 * @param {object|null} card   the raw accreditation card
 * @param {{ lang?: string, myPersonId?: string|null, myAccreditationIds?: string[] }} [options]
 *   myPersonId / myAccreditationIds = the Fiona ids of the user the page is for (marks the member that is the user)
 * @returns {{ programmes: object[], appointments: object[] }} appointments sorted by start time
 */
export function normalizeAppointments (card, { lang = 'en', myPersonId = null, myAccreditationIds = [] } = {}) {
  const mine = { personId: myPersonId ? String(myPersonId) : null, accreditationIds: new Set(asList(myAccreditationIds).map(String)) }
  const source = isRecord(card) ? card : {}

  const appointments = asList(source.appointments)
    .filter(isRecord)
    .map(raw => normalizeAppointment(raw, lang, mine))
    .sort(compareByTime)

  const seen = new Set()
  const programmes = []
  for (const raw of asList(source.meetingProgramParticipations)) {
    const programme = normalizeProgramme(raw, lang)
    if (!programme) continue
    const key = `${programme.id ?? programme.name}|${programme.role?.key ?? ''}`
    if (seen.has(key)) continue
    seen.add(key)
    programmes.push(programme)
  }

  return { programmes, appointments }
}
