/**
 * fiona/lostEditions.js
 *
 * Read-only report: which persons the sync manages hold fewer festival editions than the sync attached to them? The sync
 * records the editions it attached in `fiona_attached_edition_ids`; an edition that is recorded there but no longer on the
 * person was taken off by something else: most often the person's own profile form, which wrote its submitted list over the
 * whole relation (the Creative Gate form offers only the editions marked use_in_cg), or an editor in the admin.
 * `editedAfterSync` tells a save after the sync's own write from that write itself (the person's updated_at is a moment after
 * fiona_synced_at then); it is null when the sync time is unknown. Nothing is written.
 *
 * No Nuxt auto-imports here so the module is unit-testable.
 */

import { splitIds } from './desiredState.js'

const SYNC_OWN_WRITE_MS = 60 * 1000 // the sync's own save lands within a few seconds of fiona_synced_at

const relationId = value => (value && typeof value === 'object' ? value.id : value)
const numbers = list => [...new Set((Array.isArray(list) ? list : [])
  .map(relationId)
  .filter(id => id !== null && id !== undefined && id !== '')
  .map(Number)
  .filter(Number.isFinite))].sort((a, b) => a - b)
const nameOf = person => String(person.firstNameLastName || [person.firstName, person.lastName].filter(Boolean).join(' ')).trim()

/**
 * @param {{ strapi: { findManagedPeople: () => Promise<object[]> }, log?: object }} options
 * @returns {Promise<{ managed: number, withLost: number, withLostAfterSave: number, byEdition: object[], persons: object[] }>}
 */
export async function lostEditionsReport ({ strapi, log = console } = {}) {
  const people = (await strapi.findManagedPeople()).filter(person => person?.fiona_person_id)

  const persons = []
  for (const person of people) {
    const attached = numbers(splitIds(person.fiona_attached_edition_ids))
    const held = numbers(person.festival_editions)
    const lost = attached.filter(id => !held.includes(id))
    if (!lost.length) continue

    const synced = Date.parse(person.fiona_synced_at)
    const updated = Date.parse(person.updated_at)
    persons.push({
      personId: person.id,
      name: nameOf(person),
      lostEditionIds: lost,
      heldEditionIds: held,
      attachedEditionIds: attached,
      syncedAt: person.fiona_synced_at ?? null,
      updatedAt: person.updated_at ?? null,
      editedAfterSync: Number.isFinite(synced) && Number.isFinite(updated) ? updated - synced > SYNC_OWN_WRITE_MS : null,
      unpublished: Boolean(person.fiona_unpublished_at)
    })
  }
  persons.sort((a, b) => a.personId - b.personId)

  const counts = new Map()
  for (const person of persons) {
    for (const editionId of person.lostEditionIds) {
      const entry = counts.get(editionId) || { editionId, persons: 0, editedAfterSync: 0 }
      entry.persons++
      if (person.editedAfterSync) entry.editedAfterSync++
      counts.set(editionId, entry)
    }
  }
  const byEdition = [...counts.values()].sort((a, b) => b.persons - a.persons || a.editionId - b.editionId)

  const result = {
    managed: people.length,
    withLost: persons.length,
    withLostAfterSave: persons.filter(person => person.editedAfterSync).length,
    byEdition,
    persons
  }
  log.info?.(`[lost editions] ${result.withLost} of ${result.managed} managed persons hold less than the sync attached (${result.withLostAfterSave} saved after the sync)`)
  return result
}
