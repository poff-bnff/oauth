/**
 * fiona/photoDiagnostic.js
 *
 * Read-only diagnostic: what does Fiona hold as attachments (headshot, showcase, ...) for the persons the sync
 * manages, published or not? Uses the XAPI attachment lists of the person and of each of its accreditations and
 * reports category, type, content type, title and file name. Never shows a token, a URL or any content.
 * With probe: true (at most 10 persons) it also tries the real thing for each person, the Headshot download and the
 * Biography memo read, and reports whether that worked (size, or the error message), so a failing step is visible.
 */

const MAX_PERSONS = 100
const MAX_PROBE_PERSONS = 10

const splitIds = value => String(value ?? '').split(',').map(id => id.trim()).filter(Boolean)
const withoutToken = ({ token, ...meta }) => meta

/**
 * @param {{ personIds?: number[], all?: boolean, strapi: object, xapi: object, log?: object }} options
 *   personIds = Strapi person ids; all = every person the sync manages
 */
export async function describePhotos ({ personIds = [], all = false, probe = false, strapi, xapi, log = console } = {}) {
  let people = []
  const skipped = []
  if (all) {
    people = await strapi.findManagedPeople()
  } else {
    const ids = [...new Set((Array.isArray(personIds) ? personIds : []).map(Number).filter(id => Number.isInteger(id) && id > 0))]
    if (!ids.length) throw new Error('describePhotos needs personIds or all: true')
    if (ids.length > MAX_PERSONS) throw new Error(`describePhotos handles at most ${MAX_PERSONS} persons per call`)
    for (const id of ids) {
      let person
      try {
        person = await strapi.findPersonById(id)
      } catch (err) {
        // Strapi answers 500, not 404, for an id that does not exist
        skipped.push({ personId: id, reason: `could not be read: ${err?.message || err}` })
        continue
      }
      if (!person) skipped.push({ personId: id, reason: 'not found' })
      else if (!person.fiona_person_id) skipped.push({ personId: id, reason: 'not managed by the Fiona sync' })
      else people.push(person)
    }
  }
  if (people.length > MAX_PERSONS) throw new Error(`describePhotos handles at most ${MAX_PERSONS} persons per call`)
  if (probe && people.length > MAX_PROBE_PERSONS) throw new Error(`probe handles at most ${MAX_PROBE_PERSONS} persons per call because it downloads files`)

  const result = { persons: [], skipped, errors: [] }
  for (const person of people) {
    try {
      const own = await xapi.listPersonAttachments(person.fiona_person_id)
      const accreditations = []
      for (const id of splitIds(person.fiona_accreditation_id)) {
        accreditations.push({ id, attachments: (await xapi.listAccreditationAttachments(id)).map(withoutToken) })
      }
      const entry = {
        personId: person.id,
        name: [person.firstName, person.lastName].filter(Boolean).join(' '),
        hasPicture: Boolean(person.picture),
        person: own.map(withoutToken),
        accreditations
      }
      if (probe) {
        const accreditationIds = splitIds(person.fiona_accreditation_id)
        try {
          const headshot = await xapi.getUnpublishedHeadshot(person.fiona_person_id, accreditationIds)
          entry.headshot = headshot
            ? { ok: true, bytes: headshot.buffer.length, fileName: headshot.fileName, choice: headshot.choice, otherFiles: headshot.otherFiles }
            : { ok: false, reason: 'no Headshot image' }
        } catch (err) {
          entry.headshot = { ok: false, error: err?.message || String(err) }
        }
        try {
          const biography = await xapi.getUnpublishedBiography(accreditationIds)
          entry.biography = biography ? { ok: true, chars: biography.text.length } : { ok: false, reason: 'no Biography memo' }
        } catch (err) {
          entry.biography = { ok: false, error: err?.message || String(err) }
        }
      }
      result.persons.push(entry)
    } catch (err) {
      result.errors.push({ personId: person.id, message: err?.message || String(err) })
      log.warn?.(`[fiona photos] person #${person.id}: ${err?.message || err}`)
    }
  }
  return result
}
