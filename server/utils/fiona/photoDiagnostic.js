/**
 * fiona/photoDiagnostic.js
 *
 * Read-only diagnostic: what does Fiona hold as attachments (headshot, showcase, ...) for the persons the sync
 * manages, published or not? Uses the XAPI attachment lists of the person and of each of its accreditations and
 * reports category, type, title and file name. Never downloads a file and never shows a token or a URL.
 */

const MAX_PERSONS = 100

const splitIds = value => String(value ?? '').split(',').map(id => id.trim()).filter(Boolean)
const withoutToken = ({ token, ...meta }) => meta

/**
 * @param {{ personIds?: number[], all?: boolean, strapi: object, xapi: object, log?: object }} options
 *   personIds = Strapi person ids; all = every person the sync manages
 */
export async function describePhotos ({ personIds = [], all = false, strapi, xapi, log = console } = {}) {
  let people = []
  const skipped = []
  if (all) {
    people = await strapi.findManagedPeople()
  } else {
    const ids = [...new Set((Array.isArray(personIds) ? personIds : []).map(Number).filter(id => Number.isInteger(id) && id > 0))]
    if (!ids.length) throw new Error('describePhotos needs personIds or all: true')
    if (ids.length > MAX_PERSONS) throw new Error(`describePhotos handles at most ${MAX_PERSONS} persons per call`)
    for (const id of ids) {
      const person = await strapi.findPersonById(id)
      if (!person) skipped.push({ personId: id, reason: 'not found' })
      else if (!person.fiona_person_id) skipped.push({ personId: id, reason: 'not managed by the Fiona sync' })
      else people.push(person)
    }
  }
  if (people.length > MAX_PERSONS) throw new Error(`describePhotos handles at most ${MAX_PERSONS} persons per call`)

  const result = { persons: [], skipped, errors: [] }
  for (const person of people) {
    try {
      const own = await xapi.listPersonAttachments(person.fiona_person_id)
      const accreditations = []
      for (const id of splitIds(person.fiona_accreditation_id)) {
        accreditations.push({ id, attachments: (await xapi.listAccreditationAttachments(id)).map(withoutToken) })
      }
      result.persons.push({
        personId: person.id,
        name: [person.firstName, person.lastName].filter(Boolean).join(' '),
        hasPicture: Boolean(person.picture),
        person: own.map(withoutToken),
        accreditations
      })
    } catch (err) {
      result.errors.push({ personId: person.id, message: err?.message || String(err) })
      log.warn?.(`[fiona photos] person #${person.id}: ${err?.message || err}`)
    }
  }
  return result
}
