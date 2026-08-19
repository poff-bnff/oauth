import { describe, expect, test } from 'vitest'
import { DEFAULT_FACE_RULES, evaluateFace, normalizeFaceRules } from '../utils/photoFace.js'
// Shared between both tiers, so the cropper can ask one question of the combined findings.
import { hasBlockingFinding } from '../utils/photoQuality.js'
import { buildCheckoutCopy } from '../utils/checkoutCopy.js'

// measureFace needs a canvas and the model, so it is exercised in the browser tests. The verdict
// logic is what decides whether a paying customer is blocked, so it is covered here.
const oneGoodFace = {
  faceCount: 1,
  confidentFaceCount: 1,
  score: 0.9,
  heightRatio: 0.5,
  centreOffsetX: 0.02,
  tiltDegrees: 2,
  leftEyeRatio: 0.3,
  rightEyeRatio: 0.3,
  eyeContrastRatio: 0.8
}

describe('face verdicts', () => {
  test('a good headshot produces no findings', () => {
    expect(evaluateFace(oneGoodFace, DEFAULT_FACE_RULES)).toEqual([])
  })

  test('no face blocks', () => {
    const findings = evaluateFace({ faceCount: 0, confidentFaceCount: 0 }, DEFAULT_FACE_RULES)
    expect(findings).toEqual([{ rule: 'faceMissing', level: 'block', reason: 'faceNotFound' }])
  })

  test('two confident faces block', () => {
    const findings = evaluateFace({ ...oneGoodFace, faceCount: 2, confidentFaceCount: 2 }, DEFAULT_FACE_RULES)
    expect(findings.find(f => f.rule === 'faceMultiple').level).toBe('block')
  })

  // The asymmetry that protects the customer: a weak second detection is probably background noise,
  // so it must not block a valid photo.
  test('a weak second detection does NOT count as two faces', () => {
    const findings = evaluateFace({ ...oneGoodFace, faceCount: 2, confidentFaceCount: 1 }, DEFAULT_FACE_RULES)
    expect(findings.find(f => f.rule === 'faceMultiple')).toBeUndefined()
  })

  test('framing and tilt warn rather than block', () => {
    const cases = [
      { ...oneGoodFace, heightRatio: 0.1 },
      { ...oneGoodFace, heightRatio: 0.95 },
      { ...oneGoodFace, centreOffsetX: -0.4 },
      { ...oneGoodFace, tiltDegrees: 25 }
    ]
    for (const measurements of cases) {
      const findings = evaluateFace(measurements, DEFAULT_FACE_RULES)
      expect(findings.length).toBe(1)
      expect(findings[0].level).toBe('warn')
    }
  })

  test('off-centre is judged on magnitude, either direction', () => {
    expect(evaluateFace({ ...oneGoodFace, centreOffsetX: 0.3 }, DEFAULT_FACE_RULES)[0].rule).toBe('faceOffCentre')
    expect(evaluateFace({ ...oneGoodFace, centreOffsetX: -0.3 }, DEFAULT_FACE_RULES)[0].rule).toBe('faceOffCentre')
  })

  // One closed eye is more likely a landmark error, a wink, or hair across the face than an
  // unusable photo.
  test('only BOTH eyes closed is reported', () => {
    expect(evaluateFace({ ...oneGoodFace, leftEyeRatio: 0.05 }, DEFAULT_FACE_RULES)).toEqual([])
    expect(evaluateFace({ ...oneGoodFace, leftEyeRatio: 0.05, rightEyeRatio: 0.05 }, DEFAULT_FACE_RULES)[0].rule).toBe('eyesClosed')
  })

  test('missing eye landmarks are ignored rather than treated as closed', () => {
    expect(evaluateFace({ ...oneGoodFace, leftEyeRatio: null, rightEyeRatio: null }, DEFAULT_FACE_RULES)).toEqual([])
  })

  test('a missing face short-circuits the other rules', () => {
    // No point complaining about framing when there is nothing to frame.
    const findings = evaluateFace({ faceCount: 0, confidentFaceCount: 0, heightRatio: 0, centreOffsetX: 9, tiltDegrees: 90 }, DEFAULT_FACE_RULES)
    expect(findings).toHaveLength(1)
  })
})

describe('covered eyes / sunglasses', () => {
  // Warns rather than blocks: the threshold is uncalibrated, and telling a real customer their
  // face is hidden when it is not is a worse conversation than "your photo is blurry".
  test('flat eye regions are flagged, as a warning', () => {
    const findings = evaluateFace({ ...oneGoodFace, eyeContrastRatio: 0.1 }, DEFAULT_FACE_RULES)
    const covered = findings.find(f => f.rule === 'eyesCovered')
    expect(covered).toBeDefined()
    expect(covered.level).toBe('warn')
    expect(hasBlockingFinding(findings)).toBe(false)
  })

  test('normal eyes are not flagged', () => {
    expect(evaluateFace(oneGoodFace, DEFAULT_FACE_RULES).find(f => f.rule === 'eyesCovered')).toBeUndefined()
  })

  // Null means the eye region was too small to measure, which is not evidence of anything. Treating
  // it as "covered" would flag every small or distant face.
  test('an unmeasurable eye region says nothing', () => {
    expect(evaluateFace({ ...oneGoodFace, eyeContrastRatio: null }, DEFAULT_FACE_RULES)
      .find(f => f.rule === 'eyesCovered')).toBeUndefined()
    expect(evaluateFace({ ...oneGoodFace, eyeContrastRatio: undefined }, DEFAULT_FACE_RULES)
      .find(f => f.rule === 'eyesCovered')).toBeUndefined()
  })

  test('it can be promoted to blocking once calibrated', () => {
    const strict = { ...DEFAULT_FACE_RULES, blocking: [...DEFAULT_FACE_RULES.blocking, 'eyesCovered'] }
    expect(evaluateFace({ ...oneGoodFace, eyeContrastRatio: 0.1 }, strict)
      .find(f => f.rule === 'eyesCovered').level).toBe('block')
  })

  test('it is NOT blocking by default', () => {
    expect(DEFAULT_FACE_RULES.blocking).not.toContain('eyesCovered')
  })
})

describe('failing safe', () => {
  // The single most important behaviour here: infrastructure trouble must never present itself to
  // the customer as a problem with their photo.
  test('a model that will not load produces no findings at all', () => {
    expect(evaluateFace(null, DEFAULT_FACE_RULES)).toEqual([])
  })

  test('enabled:false silences the tier, including blocks', () => {
    expect(evaluateFace({ faceCount: 0, confidentFaceCount: 0 }, { ...DEFAULT_FACE_RULES, enabled: false })).toEqual([])
  })

  test('a partial config keeps the remaining defaults', () => {
    const partial = normalizeFaceRules({ faceMaxTiltDegrees: 20 })
    expect(partial.faceMaxTiltDegrees).toBe(20)
    expect(partial.faceMinHeightRatio).toBe(0.30)
    expect(partial.blocking).toEqual(['faceMissing', 'faceMultiple'])
  })

  test('severity is configurable, like tier 1', () => {
    const strict = { ...DEFAULT_FACE_RULES, blocking: ['faceMissing', 'faceMultiple', 'faceTilted'] }
    expect(evaluateFace({ ...oneGoodFace, tiltDegrees: 25 }, strict)[0].level).toBe('block')

    const lenient = { ...DEFAULT_FACE_RULES, blocking: [] }
    expect(evaluateFace({ faceCount: 0, confidentFaceCount: 0 }, lenient)[0].level).toBe('warn')
  })

  test('the detector thresholds are asymmetric in the customer-friendly direction', () => {
    // Lenient about "a face exists", strict about "there are two" — both let people through.
    expect(DEFAULT_FACE_RULES.presenceScoreThreshold).toBeLessThan(DEFAULT_FACE_RULES.multipleScoreThreshold)
  })
})

describe('copy for every face finding', () => {
  test.each(['en', 'et', 'ru'])('%s has every face string', (locale) => {
    const copy = buildCheckoutCopy(locale, {})
    for (const key of ['qualityChecking', 'faceNotFound', 'faceMoreThanOne', 'faceTooSmall',
      'faceTooLarge', 'faceNotCentred', 'faceTilted', 'faceEyesClosed', 'faceEyesCovered']) {
      expect(copy[key], `${locale}.${key}`).toBeTruthy()
    }
  })
})
