/**
 * fiona/photoName.js
 *
 * File name of a person photo in the Strapi media library: R_Firstname_Lastname.jpg, the convention of the headshots
 * made by the image resizer. Strapi picks the derivative sizes from the prefix (R_ = the square sizes), and the
 * photo can be found in the media library by the name of the person.
 */

const clean = value => String(value ?? '')
  .normalize('NFC')
  .replace(/[\\/:*?"<>|#%&+]/g, ' ')
  .replace(/\.+(?=\s|$)/g, '') // "Carmen L." → "Carmen L"
  .trim()
  .replace(/\s+/g, '_')
  .replace(/^_+|_+$/g, '')

/**
 * @param {string|null} firstName
 * @param {string|null} lastName
 * @param {string} [fallback]  used when the person has no name at all
 * @returns {string}
 */
export function headshotFileName (firstName, lastName, fallback = 'photo') {
  const parts = [clean(firstName), clean(lastName)].filter(Boolean)
  return `R_${parts.join('_') || fallback}.jpg`
}
