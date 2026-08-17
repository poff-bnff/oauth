// Profile pictures MUST be named `U_<slugified-email>_<userId>.<ext>`.
//
// The `U_` prefix is load-bearing, and both consumers live outside this repo:
//
//   1. Strapi's upload extension reads the first two characters of the filename
//      (`file.name.slice(0, 2)` in extensions/upload/services/image-manipulation.js) and looks
//      the prefix up in ssg/domain_specifics.yaml to decide which responsive formats to
//      generate. `U_` yields the square user crops — _big_sq / _med_sq / _small_sq / _thumb_sq.
//      Any other prefix falls through to the `NO` bucket and gets landscape `fit: inside`
//      variants instead, which are the wrong shape for an avatar.
//   2. The frontend pages resolve those square variants by the same naming.
//
// So a filename that merely looks tidy is a bug with visible consequences: wrong crops on
// upload, wrong file picked on render. Keep this helper the single source of the convention.

export const slugifyForFileName = str =>
  (str || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)+/g, '')

// Returns the name WITHOUT an extension: callers derive that from the upload's own filename or
// mime type, which differ per entry point (multipart upload vs. base64 data URL).
export function userPictureBaseName (email, userId) {
  return ['U', slugifyForFileName(email), userId].join('_')
}
