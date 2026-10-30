/**
 * fiona/sameName.js
 *
 * Before the sync creates a person it asks: does Strapi already hold a person with this name that the sync does not
 * manage? Such a person is almost always the same human, registered earlier without (or with another) e-mail, and
 * creating a second record is how the duplicates of October 2026 came about. A person that already carries another
 * Fiona id is a different Fiona person and does not count.
 */

import { nameKey, searchTerms } from './twinReport.js'

const asList = value => (Array.isArray(value) ? value : [])
const relationId = value => (value && typeof value === 'object') ? value.id : value

/**
 * @param {{ strapi: { findPeopleByNameTerm: Function }, firstName?: string, lastName?: string }} options
 * @returns {Promise<object[]>} the Strapi persons with this name and no Fiona id, lowest id first
 */
export async function findSameNamePersons ({ strapi, firstName, lastName }) {
  const name = { firstName, lastName }
  const key = nameKey(name)
  const terms = searchTerms(name)
  if (!key || !terms.length) return []

  const found = new Map()
  for (const term of terms) {
    for (const candidate of asList(await strapi.findPeopleByNameTerm(term))) found.set(Number(candidate.id), candidate)
  }
  return [...found.values()]
    .filter(candidate => nameKey(candidate) === key && !candidate.fiona_person_id)
    .sort((a, b) => Number(a.id) - Number(b.id))
}

/** The few facts needed to decide whether a Strapi person is the Fiona person: who, e-mail, login, Eventival id, picture. */
export function describeCandidate (person) {
  return {
    id: Number(person.id),
    name: String(person.firstNameLastName || [person.firstName, person.lastName].filter(Boolean).join(' ')).trim(),
    email: String(person.eMail ?? '').trim() || null,
    userId: person.user ? Number(relationId(person.user)) : null,
    remoteId: person.remoteId || null,
    hasPicture: Boolean(person.picture),
    public: person.public ?? null
  }
}
