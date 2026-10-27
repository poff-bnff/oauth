/**
 * fiona/renotify.js
 *
 * Send the Creative Gate "created" email of persons the Fiona sync made once more.
 *
 * Strapi sends that email on the save that makes a person ready (the Creative Gate edition attached and a user
 * linked), and only then. To send it again the edition is taken off and put straight back, both writes with
 * skipbuild so no site build starts. Dry run by default. Only persons the sync manages, that still hold the
 * edition and a user, and that the sync has not taken off Creative Gate.
 */

const CREATIVE_GATE_EDITION_ID = 59
const MAX_PERSONS = 100

const relationId = value => (value && typeof value === 'object' ? value.id : value)
const editionIds = list => (Array.isArray(list) ? list : []).map(relationId).filter(id => id !== null && id !== undefined).map(Number)

/**
 * @param {{ personIds: number[], dryRun?: boolean, editionId?: number }} options
 * @param {{ strapi: object, log?: object }} deps
 */
export async function renotifyPersons ({ personIds, dryRun = true, editionId = CREATIVE_GATE_EDITION_ID } = {}, { strapi, log = console } = {}) {
  const ids = [...new Set((Array.isArray(personIds) ? personIds : []).map(Number).filter(id => Number.isInteger(id) && id > 0))]
  if (!ids.length) throw new Error('renotify needs personIds')
  if (ids.length > MAX_PERSONS) throw new Error(`renotify handles at most ${MAX_PERSONS} persons per call`)

  const result = { dryRun, notify: [], skipped: [], done: [], errors: [] }
  const candidates = []
  for (const id of ids) {
    const person = await strapi.findPersonById(id)
    if (!person) result.skipped.push({ personId: id, reason: 'not found' })
    else if (!person.fiona_person_id) result.skipped.push({ personId: id, reason: 'not managed by the Fiona sync' })
    else if (!editionIds(person.festival_editions).includes(editionId)) result.skipped.push({ personId: id, reason: 'does not hold the Creative Gate edition' })
    else if (!relationId(person.user)) result.skipped.push({ personId: id, reason: 'no linked user' })
    else if (person.fiona_unpublished_at) result.skipped.push({ personId: id, reason: 'taken off Creative Gate by the sync' })
    else {
      candidates.push(person)
      result.notify.push({ personId: id, name: [person.firstName, person.lastName].filter(Boolean).join(' '), userId: Number(relationId(person.user)) })
    }
  }
  if (dryRun) return result

  for (const person of candidates) {
    const all = editionIds(person.festival_editions)
    const without = all.filter(id => id !== editionId)
    try {
      await strapi.updatePerson(person.id, { festival_editions: without, skipbuild: true })
    } catch (err) {
      result.errors.push({ personId: person.id, message: `the edition could not be taken off, nothing changed: ${err?.message || err}` })
      continue
    }
    let restored = false
    let lastError
    for (let attempt = 1; attempt <= 2 && !restored; attempt++) {
      try {
        await strapi.updatePerson(person.id, { festival_editions: all, skipbuild: true })
        restored = true
      } catch (err) {
        lastError = err
      }
    }
    if (restored) {
      result.done.push(person.id)
      log.info?.(`[fiona renotify] person #${person.id}: Creative Gate edition off and on again`)
    } else {
      const message = `restore the Creative Gate edition of person #${person.id} by hand (editions: ${all.join(', ')}): ${lastError?.message || lastError}`
      result.errors.push({ personId: person.id, message })
      log.error?.(`[fiona renotify] ${message}`)
    }
  }
  return result
}
