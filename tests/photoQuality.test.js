import { describe, expect, test } from 'vitest'
import {
  DEFAULT_QUALITY_RULES,
  evaluateImageQuality,
  hasBlockingFinding,
  normalizeQualityRules
} from '../utils/photoQuality.js'
import { buildCheckoutCopy } from '../utils/checkoutCopy.js'

// measureImageQuality needs a canvas, so it is exercised in the browser tests. The threshold logic
// is pure and is what actually decides whether a customer is blocked, so it is covered here.
const good = { sharpness: 400, meanLuminance: 130, clippedHighlights: 0.01, clippedShadows: 0.02 }

describe('quality verdicts', () => {
  test('a good photo produces no findings', () => {
    expect(evaluateImageQuality(good, DEFAULT_QUALITY_RULES)).toEqual([])
  })

  test('blocks only genuinely blurry photos', () => {
    const findings = evaluateImageQuality({ ...good, sharpness: 20 }, DEFAULT_QUALITY_RULES)
    expect(findings).toEqual([{ rule: 'sharpness', level: 'block', reason: 'qualityTooBlurry' }])
    expect(hasBlockingFinding(findings)).toBe(true)
  })

  test('warns rather than blocks in the soft-focus band', () => {
    const findings = evaluateImageQuality({ ...good, sharpness: 80 }, DEFAULT_QUALITY_RULES)
    expect(findings).toEqual([{ rule: 'sharpness', level: 'warn', reason: 'qualitySoftFocus' }])
    expect(hasBlockingFinding(findings)).toBe(false)
  })

  test('boundaries are exact', () => {
    // Exactly at the threshold must NOT trip it — the comparison is strictly "below".
    expect(evaluateImageQuality({ ...good, sharpness: 40 }, DEFAULT_QUALITY_RULES)[0].level).toBe('warn')
    expect(evaluateImageQuality({ ...good, sharpness: 39.9 }, DEFAULT_QUALITY_RULES)[0].level).toBe('block')
    expect(evaluateImageQuality({ ...good, sharpness: 120 }, DEFAULT_QUALITY_RULES)).toEqual([])
  })

  test('clipping alone warns; it is the overall exposure that blocks', () => {
    // Heavy shadows are common in a well-exposed portrait with a dark background, so clipping is
    // only a warning. Mean luminance out of range is what indicates a genuinely unusable photo.
    for (const measurements of [{ ...good, clippedHighlights: 0.5 }, { ...good, clippedShadows: 0.6 }]) {
      const findings = evaluateImageQuality(measurements, DEFAULT_QUALITY_RULES)
      expect(findings.length).toBeGreaterThan(0)
      expect(hasBlockingFinding(findings)).toBe(false)
    }
  })

  test('reports several problems at once', () => {
    const findings = evaluateImageQuality({ sharpness: 80, meanLuminance: 20, clippedShadows: 0.6, clippedHighlights: 0 }, DEFAULT_QUALITY_RULES)
    expect(findings.map(f => f.rule).sort()).toEqual(['exposure', 'shadows', 'sharpness'])
  })
})

describe('which findings block is configuration, not code', () => {
  const dark = { sharpness: 400, meanLuminance: 20, clippedHighlights: 0, clippedShadows: 0.6 }

  // Exposure blocks by default, chosen 2026-08-18 after a very dark film still sailed through.
  test('a dark photo is blocked out of the box', () => {
    const findings = evaluateImageQuality(dark, DEFAULT_QUALITY_RULES)
    expect(findings.find(f => f.rule === 'exposure').level).toBe('block')
    expect(hasBlockingFinding(findings)).toBe(true)
  })

  test("removing 'exposure' from blocking demotes it to a warning", () => {
    const findings = evaluateImageQuality(dark, { ...DEFAULT_QUALITY_RULES, blocking: ['sharpness'] })
    expect(findings.find(f => f.rule === 'exposure').level).toBe('warn')
  })

  test('an overexposed photo blocks on the same rule', () => {
    const bright = { sharpness: 400, meanLuminance: 240, clippedHighlights: 0, clippedShadows: 0 }
    expect(evaluateImageQuality(bright, DEFAULT_QUALITY_RULES)[0].level).toBe('block')
  })

  test("removing 'sharpness' makes even a blurry photo merely a warning", () => {
    const findings = evaluateImageQuality({ ...good, sharpness: 5 }, { ...DEFAULT_QUALITY_RULES, blocking: [] })
    expect(findings[0].level).toBe('warn')
    expect(hasBlockingFinding(findings)).toBe(false)
  })

  test('the soft-focus band never blocks, whatever the config says', () => {
    // Between the two sharpness thresholds the photo is usable; only "too blurry" is refusable.
    const findings = evaluateImageQuality({ ...good, sharpness: 80 }, { ...DEFAULT_QUALITY_RULES, blocking: ['sharpness'] })
    expect(findings[0].level).toBe('warn')
  })

  test('shadows and highlights can be made blocking independently', () => {
    const blown = { sharpness: 400, meanLuminance: 130, clippedHighlights: 0.5, clippedShadows: 0 }
    expect(evaluateImageQuality(blown, { ...DEFAULT_QUALITY_RULES, blocking: ['highlights'] })[0].level).toBe('block')
    expect(evaluateImageQuality(blown, DEFAULT_QUALITY_RULES)[0].level).toBe('warn')
  })
})

describe('the kill switch and configuration', () => {
  // The lever to reach for if these thresholds turn out to block real customers.
  test('enabled:false silences everything, including blocks', () => {
    expect(evaluateImageQuality({ sharpness: 0, meanLuminance: 0, clippedHighlights: 1, clippedShadows: 1 },
      { ...DEFAULT_QUALITY_RULES, enabled: false })).toEqual([])
  })

  test('a partial config keeps the remaining defaults', () => {
    // Otherwise setting one threshold in the YAML would leave the others undefined, and an
    // undefined threshold silently disables the check it exists to enforce.
    const partial = normalizeQualityRules({ sharpnessBlockBelow: 25 })
    expect(partial.sharpnessBlockBelow).toBe(25)
    expect(partial.sharpnessWarnBelow).toBe(120)
    expect(partial.meanLuminanceMax).toBe(210)
  })

  test('thresholds served by the endpoint are honoured', () => {
    const strict = { ...DEFAULT_QUALITY_RULES, sharpnessBlockBelow: 500 }
    expect(evaluateImageQuality(good, strict)[0].level).toBe('block')
  })
})

describe('copy for every finding', () => {
  // Findings carry copy KEYS; a missing translation would render an empty warning box.
  test.each(['en', 'et', 'ru'])('%s has every quality string', (locale) => {
    const copy = buildCheckoutCopy(locale, {})
    for (const key of ['qualityTooBlurry', 'qualitySoftFocus', 'qualityBlownHighlights',
      'qualityCrushedShadows', 'qualityTooDark', 'qualityTooBright', 'qualityUseAnyway']) {
      expect(copy[key], `${locale}.${key}`).toBeTruthy()
    }
  })
})
