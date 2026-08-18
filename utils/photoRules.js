// Rules for user headshot uploads, shared by every surface that produces a `U_` file.
//
// The numbers come from `userPhotoRules` in web2021/ssg/domain_specifics.yaml, served by Strapi's
// GET /photo-rules and proxied through server/api/config/photo-rules.get.js. DEFAULT_PHOTO_RULES
// below is only a last-resort fallback for when that fetch fails — the shop must keep working with
// Strapi down.
//
// A near-identical copy of this logic lives in web2021/ssg/source/userprofile/script.js, because
// the static site has no bundler and cannot import anything. Keep the two in step; the numbers
// cannot drift because both fetch them from the same endpoint, but the LOGIC can.

export const DEFAULT_PHOTO_RULES = {
  minSourceWidth: 600,
  minSourceHeight: 600,
  maxOutputSize: 1600,
  minOutputSize: 600,
  maxFileBytes: 5 * 1024 * 1024,
  aspectRatio: 1,
  // A WHITELIST, not an `image/*` check. Must stay a subset of `bitmapFormats` in web2021's
  // extensions/upload/services/image-manipulation.js, because that list gates both the JPEG
  // conversion AND the generation of the square _sq variants. A format outside it is stored
  // untouched with no variants — an SVG avatar looks fine on upload and then breaks every page
  // that asks for _med_sq. tiff/tif are in the server list but excluded here: Chrome and Firefox
  // cannot decode TIFF in an <img>, so the cropper could never show one.
  allowedMimeTypes: ['image/jpeg', 'image/png', 'image/webp'],
  // Formats the browser cannot decode but the server can convert to JPEG for us. TIFF is decoded
  // only by Safari, so without a conversion step it could never reach the cropper. HEIC is
  // deliberately absent: libheif on the Strapi box has no HEVC decoder, so a conversion attempt
  // would fail after the upload rather than before it.
  convertibleMimeTypes: ['image/tiff']
}

// Some browsers report the non-standard `image/jpg`. Treat it as JPEG rather than rejecting a
// perfectly ordinary photo on a technicality.
const MIME_ALIASES = { 'image/jpg': 'image/jpeg' }

export function normalizeMimeType (type) {
  const value = String(type || '').toLowerCase().split(';')[0].trim()

  return MIME_ALIASES[value] || value
}

// For the <input accept="..."> attribute, so the file picker offers exactly what validation will
// accept. Derived from the same list on purpose: two hardcoded lists would drift.
export function acceptAttributeFor (rules) {
  const r = normalizeRules(rules)

  // Convertible formats are offered too: they are usable, just via a detour through the server.
  return [...r.allowedMimeTypes, ...(r.convertibleMimeTypes || [])].join(',')
}

// Sends a format the browser cannot decode to the server and gets a JPEG data URL back.
// Returns null on any failure, so the caller can fall back to a plain rejection message.
export async function convertUnsupportedImage (dataUrl) {
  try {
    const result = await $fetch('/api/config/photo-convert', {
      method: 'POST',
      body: { data: dataUrl }
    })

    return result?.data || null
  } catch (err) {
    console.warn('[photo] conversion failed', err) // eslint-disable-line no-console
    return null
  }
}

export function normalizeRules (rules) {
  return { ...DEFAULT_PHOTO_RULES, ...(rules || {}) }
}

// Module-level cache: several components can ask for the rules on one page (the checkout renders a
// photo field per gift item), and they should share a single request.
let rulesPromise = null

export function loadPhotoRules () {
  if (!rulesPromise) {
    rulesPromise = $fetch('/api/config/photo-rules')
      .then(normalizeRules)
      .catch(() => {
        // Let the next caller retry rather than caching a failure for the life of the page.
        rulesPromise = null
        return DEFAULT_PHOTO_RULES
      })
  }

  return rulesPromise
}

// Returns { ok: true } or { ok: false, reason } where reason is a copy key, not a message —
// each frontend has its own translation lookup.
export function validateSource (file, dims, rules) {
  const r = normalizeRules(rules)

  if (!file) {
    return { ok: false, reason: 'photoNotImage' }
  }
  // Checked before anything else: an SVG passes a naive `image/*` test and is then stored with no
  // square variants at all, which fails silently rather than loudly.
  const mimeType = normalizeMimeType(file.type)

  if (!r.allowedMimeTypes.includes(mimeType)) {
    // Not a rejection: the caller should send it to /api/config/photo-convert and try again with
    // the JPEG it returns.
    if ((r.convertibleMimeTypes || []).includes(mimeType)) {
      return { ok: false, reason: 'photoNeedsConversion', convertible: true }
    }
    return { ok: false, reason: 'photoWrongFormat' }
  }
  if (file.size > r.maxFileBytes) {
    return { ok: false, reason: 'photoTooLarge' }
  }
  if (!dims || !dims.width || !dims.height) {
    return { ok: false, reason: 'photoNotImage' }
  }
  // Deliberately no maximum: the output is capped when the crop is exported, so a 4000×3000 phone
  // photo is fine. Only "too few pixels to crop from" is a real problem, because upscaling a
  // headshot to fill the 900×900 variant looks visibly worse than every neighbouring avatar.
  if (dims.width < r.minSourceWidth || dims.height < r.minSourceHeight) {
    return { ok: false, reason: 'photoTooSmall' }
  }

  return { ok: true }
}

// The square edge length to export at, given the size of the region the user selected.
//
// Capped at maxOutputSize, and NEVER upscaled. An earlier version lifted anything below
// minOutputSize up to it, which invented pixels: validateSource only guarantees the SOURCE is at
// least 600x600, and the user can select a much smaller region inside it. A 467px selection was
// being saved as a blurry 600px square.
//
// minOutputSize is enforced where it belongs instead — on the crop box, via minSelectionFor below,
// so a too-small region cannot be selected at all. This function keeps the floor out of the export
// path entirely: if a small selection somehow arrives here, honest small pixels beat fake big ones.
export function outputSizeFor (cropWidth, rules) {
  const r = normalizeRules(rules)
  const requested = Math.round(cropWidth || 0)

  return requested > r.maxOutputSize ? r.maxOutputSize : requested
}

// Smallest square the user may select, in SOURCE pixels. Never larger than the image itself, so a
// photo at exactly the minimum can still be cropped (the box then covers the whole image).
export function minSelectionFor (sourceWidth, sourceHeight, rules) {
  const r = normalizeRules(rules)

  return Math.min(r.minOutputSize, sourceWidth || r.minOutputSize, sourceHeight || r.minOutputSize)
}

export function getImageDimensions (src) {
  return new Promise((resolve) => {
    const img = new Image()
    img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight })
    img.onerror = () => resolve(null)
    img.src = src
  })
}

// Byte length of a base64 data URL's payload. Needed because after a server-side conversion the
// only thing we hold is the data URL — and re-checking the size limit against the ORIGINAL file
// would reject a 10 MB TIFF that became a perfectly acceptable 2 MB JPEG.
export function dataUrlByteLength (dataUrl) {
  const base64 = String(dataUrl || '').split(',')[1] || ''
  const padding = (base64.match(/=+$/) || [''])[0].length

  return Math.max(0, Math.floor(base64.length * 3 / 4) - padding)
}

export function fileToDataUrl (file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result)
    reader.onerror = reject
    reader.readAsDataURL(file)
  })
}

// Keeps the uploaded file's base name but forces the extension to match what the canvas actually
// produced. Cropping re-encodes, so a .png that comes back as JPEG must not keep claiming .png.
export function croppedFileName (originalName, mimeType) {
  const base = String(originalName || 'photo').replace(/\.[^.]+$/, '') || 'photo'
  const ext = mimeType === 'image/png' ? 'png' : 'jpg'

  return `${base}.${ext}`
}
