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
  aspectRatio: 1
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

  if (!file || !String(file.type || '').startsWith('image/')) {
    return { ok: false, reason: 'photoNotImage' }
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
