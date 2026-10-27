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
 * Three Fiona accreditation flags keep contact data off the public person record:
 *   noPublicationOfContactDetails  "Do not publish contact details"  → email and phone
 *   noPublicationOfEmail           "Do not publish email info"       → email
 *   noPublicationOfPhone           "Do not publish phone info"       → phone
 * The login user and the user-profile still receive the email.
 */
export function buildPersonPayload ({
  fionaPerson,
  level,
  contactEmail,
  noPublicationOfContactDetails = false,
  noPublicationOfEmail = false,
  noPublicationOfPhone = false
}) {
  const firstName = fionaPerson?.firstName || null
  const lastName = fionaPerson?.lastName || null

  const payload = {
    firstName,
    lastName,
    firstNameLastName: [firstName, lastName].filter(Boolean).join(' ') || null
  }

  if (contactEmail && !noPublicationOfContactDetails && !noPublicationOfEmail) payload.eMail = contactEmail
  if (fionaPerson?.phone && !noPublicationOfContactDetails && !noPublicationOfPhone) payload.phoneNr = fionaPerson.phone

  if (level >= 2) {
    if (fionaPerson?.bio) payload.bio_en = fionaPerson.bio
    // Mapping step (next): country → ev_country, role at films, films / projects.
  }

  return payload
}

const digitsOnly = value => String(value ?? '').replace(/\D/g, '')
const sameEmail = (a, b) => String(a ?? '').trim().toLowerCase() === String(b ?? '').trim().toLowerCase()

/**
 * A box ticked after the sync already wrote the value: the stored email or phone
 * must come off the person again. Only a stored value that equals what Fiona holds
 * is cleared (phone compared by digits, email ignoring case), so a value someone
 * typed in themselves is never touched. Returns { eMail: null } and / or { phoneNr: null }.
 */
export function valuesToClear ({ existing, fionaPerson, contactEmail, withholdEmail = false, withholdPhone = false }) {
  const clear = {}
  if (!existing) return clear
  if (withholdEmail && existing.eMail && contactEmail && sameEmail(existing.eMail, contactEmail)) clear.eMail = null
  const stored = digitsOnly(existing.phoneNr)
  if (withholdPhone && stored && stored === digitsOnly(fionaPerson?.phone)) clear.phoneNr = null
  return clear
}
