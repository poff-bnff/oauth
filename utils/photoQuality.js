// Tier 1 photo quality checks: sharpness and exposure, computed from pixels alone.
//
// No library and no model — these run on the cropped canvas the user is about to upload, so they
// cost nothing to download and add no dependency. The face checks (tier 2) are a separate concern
// and need a ~1.6 MB model.
//
// Analysis always happens at ANALYSIS_SIZE, never at the image's own resolution. Laplacian
// variance scales with resolution and JPEG quality, so measuring a 1600px crop and a 600px crop
// would produce numbers that cannot be compared to each other or to a fixed threshold.
//
// A near-identical copy lives in web2021/ssg/source/userprofile/script.js and personForm/script.js,
// because the static site has no bundler. Keep them in step.

const ANALYSIS_SIZE = 600

export const DEFAULT_QUALITY_RULES = {
  enabled: true,
  // Which findings STOP the upload rather than merely warning. Everything not named here is a
  // warning the user can accept. Rule names: sharpness, exposure, highlights, shadows.
  //
  // Only sharpness blocks by default, because a blurry photo is unusable whereas a dark one is a
  // judgement call. Add 'exposure' here to make under/overexposed photos blocking too.
  blocking: ['sharpness', 'exposure'],
  // Laplacian variance. These are STARTING POINTS, not measurements — they need calibrating
  // against real pass photos before anyone should trust them.
  sharpnessBlockBelow: 6,
  sharpnessWarnBelow: 70,
  // Share of pixels at the extremes, 0..1.
  clippedHighlightsWarnAbove: 0.15,
  clippedShadowsWarnAbove: 0.25,
  // Mean luminance, 0..255.
  meanLuminanceMin: 36,
  meanLuminanceMax: 210
}

export function normalizeQualityRules (rules) {
  return { ...DEFAULT_QUALITY_RULES, ...(rules || {}) }
}

// A finding's severity is configuration, not something baked into the code.
const levelFor = (rule, rules) => (rules.blocking || []).includes(rule) ? 'block' : 'warn'

// Returns raw measurements. Deliberately separate from the verdict, so the same numbers can be
// displayed for calibration without any thresholds being applied.
export function measureImageQuality (source) {
  const canvas = document.createElement('canvas')
  canvas.width = ANALYSIS_SIZE
  canvas.height = ANALYSIS_SIZE

  const context = canvas.getContext('2d', { willReadFrequently: true })
  context.drawImage(source, 0, 0, ANALYSIS_SIZE, ANALYSIS_SIZE)

  const { data } = context.getImageData(0, 0, ANALYSIS_SIZE, ANALYSIS_SIZE)
  const pixels = ANALYSIS_SIZE * ANALYSIS_SIZE
  const grey = new Float32Array(pixels)

  let sum = 0
  let clippedHigh = 0
  let clippedLow = 0

  for (let i = 0; i < pixels; i++) {
    // Rec. 601 luma — matches how the eye weights the channels.
    const value = 0.299 * data[i * 4] + 0.587 * data[i * 4 + 1] + 0.114 * data[i * 4 + 2]
    grey[i] = value
    sum += value
    if (value >= 250) clippedHigh++
    if (value <= 5) clippedLow++
  }

  // 3x3 Laplacian. The variance of the response is the standard cheap focus measure: a sharp image
  // has strong edges and therefore a wide spread of responses; a blurred one has responses near 0.
  let laplacianSum = 0
  let laplacianSquares = 0
  let counted = 0

  for (let y = 1; y < ANALYSIS_SIZE - 1; y++) {
    for (let x = 1; x < ANALYSIS_SIZE - 1; x++) {
      const i = y * ANALYSIS_SIZE + x
      const response =
        grey[i - ANALYSIS_SIZE] + grey[i + ANALYSIS_SIZE] +
        grey[i - 1] + grey[i + 1] -
        4 * grey[i]

      laplacianSum += response
      laplacianSquares += response * response
      counted++
    }
  }

  const laplacianMean = laplacianSum / counted

  return {
    sharpness: (laplacianSquares / counted) - (laplacianMean * laplacianMean),
    meanLuminance: sum / pixels,
    clippedHighlights: clippedHigh / pixels,
    clippedShadows: clippedLow / pixels
  }
}

// Turns measurements into findings. Each carries a copy KEY, not a message — every frontend has
// its own translation lookup.
export function evaluateImageQuality (measurements, rules) {
  const r = normalizeQualityRules(rules)
  const findings = []

  if (!r.enabled) return findings

  // Sharpness has two bands: below the block threshold it takes its configured level, between the
  // two it is always only a warning — "slightly soft" is never grounds for refusing a photo.
  if (measurements.sharpness < r.sharpnessBlockBelow) {
    findings.push({ rule: 'sharpness', level: levelFor('sharpness', r), reason: 'qualityTooBlurry' })
  } else if (measurements.sharpness < r.sharpnessWarnBelow) {
    findings.push({ rule: 'sharpness', level: 'warn', reason: 'qualitySoftFocus' })
  }

  if (measurements.clippedHighlights > r.clippedHighlightsWarnAbove) {
    findings.push({ rule: 'highlights', level: levelFor('highlights', r), reason: 'qualityBlownHighlights' })
  }

  if (measurements.clippedShadows > r.clippedShadowsWarnAbove) {
    findings.push({ rule: 'shadows', level: levelFor('shadows', r), reason: 'qualityCrushedShadows' })
  }

  if (measurements.meanLuminance < r.meanLuminanceMin) {
    findings.push({ rule: 'exposure', level: levelFor('exposure', r), reason: 'qualityTooDark' })
  } else if (measurements.meanLuminance > r.meanLuminanceMax) {
    findings.push({ rule: 'exposure', level: levelFor('exposure', r), reason: 'qualityTooBright' })
  }

  return findings
}

export const hasBlockingFinding = findings => (findings || []).some(f => f.level === 'block')
