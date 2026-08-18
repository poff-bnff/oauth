import { describe, expect, test } from 'vitest'
import {
  DEFAULT_PHOTO_RULES,
  acceptAttributeFor,
  croppedFileName,
  minSelectionFor,
  normalizeMimeType,
  normalizeRules,
  outputSizeFor,
  validateSource
} from '../utils/photoRules.js'
import { buildCheckoutCopy } from '../utils/checkoutCopy.js'

const imageFile = (overrides = {}) => ({ type: 'image/jpeg', size: 1024, name: 'photo.jpg', ...overrides })

describe('source validation', () => {
  test('accepts an image at exactly the minimum', () => {
    expect(validateSource(imageFile(), { width: 600, height: 600 }, DEFAULT_PHOTO_RULES).ok).toBe(true)
  })

  test('rejects one pixel below the minimum on either axis', () => {
    expect(validateSource(imageFile(), { width: 599, height: 600 }, DEFAULT_PHOTO_RULES)).toEqual({ ok: false, reason: 'photoTooSmall' })
    expect(validateSource(imageFile(), { width: 600, height: 599 }, DEFAULT_PHOTO_RULES)).toEqual({ ok: false, reason: 'photoTooSmall' })
  })

  // The old checkout rejected anything over 3000px, which excluded essentially every phone camera.
  // The output is capped at export instead, so large sources are fine now.
  test('accepts a large phone photo that the old 3000px ceiling rejected', () => {
    expect(validateSource(imageFile(), { width: 4032, height: 3024 }, DEFAULT_PHOTO_RULES).ok).toBe(true)
  })

  // The bug that prompted this: image/svg+xml passes a naive `image/*` test, and Strapi then
  // stores it with NO square variants, because bitmapFormats gates variant generation too. It
  // looks fine on upload and breaks every page that asks for _med_sq.
  test('rejects SVG, which a naive image/* check would let through', () => {
    expect(validateSource(imageFile({ type: 'image/svg+xml', name: 'logo.svg' }), { width: 900, height: 900 }, DEFAULT_PHOTO_RULES))
      .toEqual({ ok: false, reason: 'photoWrongFormat' })
  })

  test('rejects other formats Strapi would store without variants', () => {
    for (const type of ['image/gif', 'image/avif', 'image/bmp', 'image/heic', 'image/tiff']) {
      expect(validateSource(imageFile({ type }), { width: 900, height: 900 }, DEFAULT_PHOTO_RULES).reason, type)
        .toBe('photoWrongFormat')
    }
  })

  test('accepts the three whitelisted formats', () => {
    for (const type of ['image/jpeg', 'image/png', 'image/webp']) {
      expect(validateSource(imageFile({ type }), { width: 900, height: 900 }, DEFAULT_PHOTO_RULES).ok, type).toBe(true)
    }
  })

  // Some browsers report the non-standard image/jpg for an ordinary JPEG.
  test('accepts the non-standard image/jpg alias', () => {
    expect(validateSource(imageFile({ type: 'image/jpg' }), { width: 900, height: 900 }, DEFAULT_PHOTO_RULES).ok).toBe(true)
    expect(normalizeMimeType('IMAGE/JPG')).toBe('image/jpeg')
    expect(normalizeMimeType('image/jpeg; charset=binary')).toBe('image/jpeg')
  })

  test('rejects non-images and oversized files', () => {
    expect(validateSource(imageFile({ type: 'application/pdf' }), { width: 900, height: 900 }, DEFAULT_PHOTO_RULES).reason).toBe('photoWrongFormat')
    expect(validateSource(imageFile({ size: 6 * 1024 * 1024 }), { width: 900, height: 900 }, DEFAULT_PHOTO_RULES).reason).toBe('photoTooLarge')
  })

  test('treats undecodable images as not-an-image rather than passing them through', () => {
    expect(validateSource(imageFile(), null, DEFAULT_PHOTO_RULES).reason).toBe('photoNotImage')
  })

  test('honours rules supplied by the endpoint rather than the built-in defaults', () => {
    const strict = { ...DEFAULT_PHOTO_RULES, minSourceWidth: 1000, minSourceHeight: 1000 }
    expect(validateSource(imageFile(), { width: 800, height: 800 }, strict).ok).toBe(false)
    expect(validateSource(imageFile(), { width: 1200, height: 1200 }, strict).ok).toBe(true)
  })
})

describe('output sizing', () => {
  test('caps at maxOutputSize', () => {
    expect(outputSizeFor(4000, DEFAULT_PHOTO_RULES)).toBe(1600)
    expect(outputSizeFor(1601, DEFAULT_PHOTO_RULES)).toBe(1600)
  })

  // Regression: this used to lift anything under 600 UP to 600, inventing pixels. A 467px
  // selection from a 738px source was being saved as a blurry 600px square.
  test('never upscales a small selection', () => {
    expect(outputSizeFor(467, DEFAULT_PHOTO_RULES)).toBe(467)
    expect(outputSizeFor(120, DEFAULT_PHOTO_RULES)).toBe(120)
  })

  test('keeps a selection that already sits inside the range', () => {
    expect(outputSizeFor(900, DEFAULT_PHOTO_RULES)).toBe(900)
    expect(outputSizeFor(600, DEFAULT_PHOTO_RULES)).toBe(600)
    expect(outputSizeFor(1600, DEFAULT_PHOTO_RULES)).toBe(1600)
  })
})

describe('accept attribute', () => {
  // Derived from the same list the validation uses, so the file picker cannot offer something
  // that is then rejected.
  test('matches the whitelist', () => {
    expect(acceptAttributeFor(DEFAULT_PHOTO_RULES)).toBe('image/jpeg,image/png,image/webp')
  })

  test('follows the endpoint rules', () => {
    expect(acceptAttributeFor({ ...DEFAULT_PHOTO_RULES, allowedMimeTypes: ['image/png'] })).toBe('image/png')
  })
})

describe('minimum selection size', () => {
  // The floor belongs on the crop box, not the export: this is what makes upscaling impossible
  // rather than merely undone.
  test('is the configured minimum for a comfortably large source', () => {
    expect(minSelectionFor(3000, 2000, DEFAULT_PHOTO_RULES)).toBe(600)
  })

  test('never exceeds the source, so a 600x600 photo is still croppable', () => {
    expect(minSelectionFor(600, 600, DEFAULT_PHOTO_RULES)).toBe(600)
    // Below the accepted minimum the box simply covers the whole image rather than locking up.
    expect(minSelectionFor(500, 400, DEFAULT_PHOTO_RULES)).toBe(400)
  })

  test('follows the endpoint rules', () => {
    expect(minSelectionFor(3000, 3000, { ...DEFAULT_PHOTO_RULES, minOutputSize: 900 })).toBe(900)
  })
})

describe('rule normalisation', () => {
  // A partially-filled config must not produce undefined limits: an undefined minimum silently
  // disables the check it exists to enforce.
  test('fills gaps from the defaults', () => {
    expect(normalizeRules({ maxOutputSize: 1200 })).toEqual({ ...DEFAULT_PHOTO_RULES, maxOutputSize: 1200 })
    expect(normalizeRules(null)).toEqual(DEFAULT_PHOTO_RULES)
    expect(normalizeRules(undefined).minSourceWidth).toBe(600)
  })
})

describe('cropped file naming', () => {
  test('rewrites the extension to match what the canvas produced', () => {
    // Cropping re-encodes, so a .png that came back as JPEG must stop claiming to be a PNG.
    expect(croppedFileName('holiday.png', 'image/jpeg')).toBe('holiday.jpg')
    expect(croppedFileName('holiday.png', 'image/png')).toBe('holiday.png')
    expect(croppedFileName('no-extension', 'image/jpeg')).toBe('no-extension.jpg')
    expect(croppedFileName('', 'image/jpeg')).toBe('photo.jpg')
  })
})

describe('copy keys the cropper depends on', () => {
  // validateSource returns copy KEYS; a missing translation would render the modal blank.
  test.each(['en', 'et', 'ru'])('%s has every crop and photo string', (locale) => {
    const copy = buildCheckoutCopy(locale, {})
    for (const key of ['cropTitle', 'cropInstruction', 'cropConfirm', 'cropCancel', 'photoTooSmall', 'photoNotImage', 'photoWrongFormat', 'photoTooLarge', 'photoWrongSize', 'photoHelp']) {
      expect(copy[key], `${locale}.${key}`).toBeTruthy()
    }
  })

  test('photoHelp no longer advertises the removed 3000px ceiling', () => {
    for (const locale of ['en', 'et', 'ru']) {
      expect(buildCheckoutCopy(locale, {}).photoHelp).not.toContain('3000')
    }
  })
})
