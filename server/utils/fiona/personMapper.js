/**
 * fiona/personMapper.js
 *
 * Builds the Strapi `person` payload from a normalised Fiona person.
 * This is the single place to extend when the Fiona → Strapi field mapping
 * grows (country, role at films, connected films / projects, …).
 *
 * Level 1 (basic): firstName, lastName, firstNameLastName, eMail, phoneNr.
 * Level 2 (full):  basic + bio_en (more fields follow in the mapping step).
 *
 * `noPublicationOfContactDetails` (Fiona accreditation flag) keeps email and
 * phone off the public person record; the login user and the user-profile
 * still receive the email.
 */
export function buildPersonPayload ({ fionaPerson, level, contactEmail, noPublicationOfContactDetails = false }) {
  const firstName = fionaPerson?.firstName || null
  const lastName = fionaPerson?.lastName || null

  const payload = {
    firstName,
    lastName,
    firstNameLastName: [firstName, lastName].filter(Boolean).join(' ') || null
  }

  if (!noPublicationOfContactDetails) {
    if (contactEmail) payload.eMail = contactEmail
    if (fionaPerson?.phone) payload.phoneNr = fionaPerson.phone
  }

  if (level >= 2) {
    if (fionaPerson?.bio) payload.bio_en = fionaPerson.bio
    // Mapping step (next): country → ev_country, role at films, films / projects.
  }

  return payload
}
