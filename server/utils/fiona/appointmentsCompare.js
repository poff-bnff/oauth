/**
 * fiona/appointmentsCompare.js
 *
 * The live appointments (XAPI, see liveAppointments.js) against the published ones (the accreditation card, see
 * appointments.js), appointment by appointment: which exist on one side only and, for those on both, which fields differ.
 * Only field names are reported unless `showValues` is set. Used by the read-only probe mode `liveAppointments`; pure.
 */

const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const asList = value => (Array.isArray(value) ? value : [])
const trimmed = value => (typeof value === 'string' || typeof value === 'number' ? String(value).trim() : '')
const orNull = value => trimmed(value) || null

const moment = (value) => {
  const time = Date.parse(trimmed(value))
  return Number.isNaN(time) ? null : new Date(time).toISOString()
}

const nameKey = value => trimmed(value).toLowerCase().replace(/\s+/g, ' ')

/** The people of an appointment as sorted "name | role" strings, so order, case and ids do not matter. */
const memberKeys = appointment => asList(appointment.members).filter(isRecord)
  .map(member => (member.role?.text ? `${nameKey(member.name)} | ${nameKey(member.role.text)}` : nameKey(member.name)))
  .sort()

// [field, how to read the comparable value, how to show it]
const FIELDS = [
  ['startsOn', a => moment(a.startsOn), a => moment(a.startsOn)],
  ['endsOn', a => moment(a.endsOn), a => moment(a.endsOn)],
  ['type', a => (a.type ? nameKey(a.type.text) : null), a => orNull(a.type?.text)],
  ['subject', a => trimmed(a.subject), a => trimmed(a.subject)],
  ['location', a => orNull(a.location), a => orNull(a.location)],
  ['isOnline', a => a.isOnline === true, a => a.isOnline === true],
  ['table', a => orNull(a.table), a => orNull(a.table)],
  ['members', a => JSON.stringify(memberKeys(a)), a => memberKeys(a)]
]

const byId = list => new Map(list.filter(item => isRecord(item) && item.id !== null && item.id !== undefined).map(item => [String(item.id), item]))

export function compareAppointmentLists (live, published, { showValues = false } = {}) {
  const liveList = asList(live)
  const publishedList = asList(published)
  const liveById = byId(liveList)
  const publishedById = byId(publishedList)

  const onlyInLive = [...liveById.keys()].filter(id => !publishedById.has(id)).sort()
  const onlyInPublished = [...publishedById.keys()].filter(id => !liveById.has(id)).sort()

  const different = []
  let same = 0
  for (const id of [...liveById.keys()].filter(key => publishedById.has(key)).sort()) {
    const a = liveById.get(id)
    const b = publishedById.get(id)
    const fields = FIELDS.filter(([, read]) => read(a) !== read(b))
    if (!fields.length) { same++; continue }
    const entry = { id, fields: fields.map(([name]) => name) }
    if (showValues) entry.values = Object.fromEntries(fields.map(([name, , show]) => [name, { live: show(a), published: show(b) }]))
    different.push(entry)
  }

  return { live: liveList.length, published: publishedList.length, same, onlyInLive, onlyInPublished, different }
}
