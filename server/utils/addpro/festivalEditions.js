/**
 * addpro/festivalEditions.js
 *
 * The Creative Gate profile form (person and organisation) offers only the festival editions marked use_in_cg, and a save
 * writes the submitted list over the person's whole relation. An edition the form does not offer (the Industry@Tallinn
 * edition the Fiona sync attached, one an editor gave) was therefore dropped by the next save of the profile. The editions
 * the form can show stay under the person's control (tick / untick); the others are kept.
 *
 * No Nuxt auto-imports here so the module is unit-testable.
 */

const idOf = value => (value && typeof value === 'object' ? value.id : value)
const idsOf = list => [...new Set((Array.isArray(list) ? list : [])
  .map(idOf)
  .filter(id => id !== null && id !== undefined && id !== '')
  .map(Number)
  .filter(Number.isFinite))]

/**
 * @param {{ submitted: Array, original: Array, offered: Array|null }} options
 *   submitted = the list the form sent; original = what the person holds now (ids or relation objects);
 *   offered = the ids of the editions the form offers, null when that is not known (then nothing is dropped)
 * @returns {number[]} the submitted editions, then the held editions the form does not offer
 */
export function keepEditionsTheFormDoesNotOffer ({ submitted, original, offered }) {
  const offeredIds = offered === null || offered === undefined ? null : idsOf(offered)
  const kept = idsOf(original).filter(id => offeredIds === null || !offeredIds.includes(id))
  return [...new Set([...idsOf(submitted), ...kept])]
}
