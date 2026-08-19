// Tier 2 checks: is this actually a photo of one person, framed usably?
//
// face-api.js is loaded ON DEMAND — 1.3 MB of code plus ~270 KB of model weights. Nobody browsing
// the shop pays for it; the download starts only once a file has been chosen and has already
// passed the cheap tier 1 checks.
//
// TinyFaceDetector plus the 68-point TINY landmark model, not the full-size variants: together
// they are about a tenth of the size and enough for face count, framing, tilt and eye openness.
// Nothing here attempts identity or demographics — only geometry.
//
// A near-identical copy lives in the SSG page scripts, which cannot import anything.

export const DEFAULT_FACE_RULES = {
  enabled: true,
  // Findings that stop the upload. Only the unambiguous ones by default: "not a person" and "more
  // than one person" are judgements a detector gets right regardless of lighting or camera, whereas
  // framing and tilt are matters of taste.
  blocking: ['faceMissing', 'faceMultiple'],
  // Face box height as a share of the crop.
  faceMinHeightRatio: 0.30,
  faceMaxHeightRatio: 0.80,
  // How far the face centre may sit from the crop centre, as a share of width.
  faceMaxCentreOffset: 0.15,
  // Degrees of roll, measured from the line between the eye centres.
  faceMaxTiltDegrees: 12,
  // Eye aspect ratio below which an eye reads as closed.
  eyeOpenMinRatio: 0.15,
  // Sunglasses/occlusion. The signal is UNIFORMITY, not darkness: a real eye has a bright sclera
  // immediately beside a dark iris, so it has strong local contrast in a small area, whereas a lens
  // is flat. Darkness alone would track skin tone and side lighting, and would disproportionately
  // flag people with darker or deep-set eyes — a fairness problem before it is a support problem.
  //
  // Measured as the eye region's own p95-p5 luminance spread divided by the face's, so it does not
  // simply follow exposure. Starting point only; calibrate against real photos before trusting it,
  // and note it will struggle with mirrored lenses and heavy shadow across the eyes.
  eyeContrastMinRatio: 0.35,
  // Deliberately ASYMMETRIC confidence, and both directions fail toward letting the customer
  // through: a weak detection still counts as "a face is present", so an awkwardly-lit face is not
  // refused, while only confident detections count toward "more than one face", so a spurious blob
  // in the background cannot block a valid photo.
  presenceScoreThreshold: 0.3,
  multipleScoreThreshold: 0.5,
  // The detector works on a square input; 416 is face-api's sweet spot for speed against accuracy.
  detectorInputSize: 416
}

export function normalizeFaceRules (rules) {
  return { ...DEFAULT_FACE_RULES, ...(rules || {}) }
}

// Backend order matters. WebGL is fast when available; CPU is pure JS — slower, but it needs no
// extra files and works everywhere.
//
// WASM is deliberately EXCLUDED. tfjs registers it and ranks it above CPU, but it needs
// tfjs-backend-wasm-simd.wasm served alongside the bundle. Without that file tfjs picks wasm,
// fails to initialise, and ends up with no backend at all — which is exactly what happened in
// testing: the model never loaded and every face check silently did nothing.
const BACKEND_PREFERENCE = ['webgl', 'cpu']

async function selectBackend (tf) {
  if (!tf || typeof tf.setBackend !== 'function') return null

  for (const backend of BACKEND_PREFERENCE) {
    try {
      if (await tf.setBackend(backend)) {
        await tf.ready()
        return backend
      }
    } catch {
      // Try the next one. A missing backend is expected, not exceptional.
    }
  }

  return null
}

let loader = null

// Resolves to the face-api module with both models in memory, or null if anything fails. Never
// throws: a model that will not load must not make photo upload impossible.
export function loadFaceApi (modelUrl = '/face-models') {
  if (!loader) {
    loader = (async () => {
      const faceapi = await import('@vladmandic/face-api')

      const backend = await selectBackend(faceapi.tf)
      if (!backend) throw new Error('no usable tfjs backend')

      await Promise.all([
        faceapi.nets.tinyFaceDetector.loadFromUri(modelUrl),
        faceapi.nets.faceLandmark68TinyNet.loadFromUri(modelUrl)
      ])

      return faceapi
    })().catch((err) => {
      console.warn('[photo] face model failed to load', err) // eslint-disable-line no-console
      // Cleared so a later attempt can retry rather than being stuck with the failure.
      loader = null
      return null
    })
  }

  return loader
}

const degrees = radians => radians * 180 / Math.PI

// Luminance spread of a landmark region, expressed as p95 - p5 so a single specular highlight or
// one dark lash does not dominate. Returns null when the region is too small to judge.
function luminanceSpread (context, points, padding = 0.15) {
  if (!points || !points.length) return null

  const xs = points.map(p => p.x)
  const ys = points.map(p => p.y)
  const padX = (Math.max(...xs) - Math.min(...xs)) * padding
  const padY = (Math.max(...ys) - Math.min(...ys)) * padding

  const x = Math.max(0, Math.floor(Math.min(...xs) - padX))
  const y = Math.max(0, Math.floor(Math.min(...ys) - padY))
  const width = Math.min(context.canvas.width - x, Math.ceil(Math.max(...xs) - Math.min(...xs) + padX * 2))
  const height = Math.min(context.canvas.height - y, Math.ceil(Math.max(...ys) - Math.min(...ys) + padY * 2))

  if (width < 4 || height < 4) return null

  const { data } = context.getImageData(x, y, width, height)
  const values = []

  for (let i = 0; i < data.length; i += 4) {
    values.push(0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2])
  }

  values.sort((a, b) => a - b)
  const at = q => values[Math.min(values.length - 1, Math.floor(values.length * q))]

  return at(0.95) - at(0.05)
}

// Mean distance between the vertical pairs of an eye's 6 landmarks, over its width. A closed eye
// collapses vertically while staying the same width, so the ratio drops sharply.
function eyeAspectRatio (eye) {
  if (!eye || eye.length < 6) return null

  const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y)
  const vertical = (distance(eye[1], eye[5]) + distance(eye[2], eye[4])) / 2
  const horizontal = distance(eye[0], eye[3])

  return horizontal > 0 ? vertical / horizontal : null
}

// Runs detection and returns raw geometry, with no thresholds applied — so the same numbers can be
// displayed for calibration.
export async function measureFace (canvas, rules, modelUrl) {
  const r = normalizeFaceRules(rules)
  const faceapi = await loadFaceApi(modelUrl)

  if (!faceapi) return null

  const options = new faceapi.TinyFaceDetectorOptions({
    inputSize: r.detectorInputSize,
    scoreThreshold: r.presenceScoreThreshold
  })

  const detections = await faceapi.detectAllFaces(canvas, options).withFaceLandmarks(true)

  const confident = detections.filter(d => d.detection.score >= r.multipleScoreThreshold)
  const primary = detections.slice().sort((a, b) => b.detection.score - a.detection.score)[0]

  if (!primary) {
    return { faceCount: 0, confidentFaceCount: 0 }
  }

  const box = primary.detection.box
  const landmarks = primary.landmarks
  const leftEye = landmarks.getLeftEye()
  const rightEye = landmarks.getRightEye()

  const centre = points => points.reduce(
    (acc, p) => ({ x: acc.x + p.x / points.length, y: acc.y + p.y / points.length }), { x: 0, y: 0 })
  const leftCentre = centre(leftEye)
  const rightCentre = centre(rightEye)

  // Eye contrast relative to the whole face, so the measure survives a dark or bright photo.
  const context = canvas.getContext('2d', { willReadFrequently: true })
  const faceSpread = luminanceSpread(context, landmarks.positions, 0)
  const eyeSpread = [leftEye, rightEye]
    .map(eye => luminanceSpread(context, eye))
    .filter(v => typeof v === 'number')
  const eyeContrastRatio = (faceSpread && eyeSpread.length)
    ? (eyeSpread.reduce((a, b) => a + b, 0) / eyeSpread.length) / faceSpread
    : null

  return {
    faceCount: detections.length,
    confidentFaceCount: confident.length,
    score: primary.detection.score,
    eyeContrastRatio,
    heightRatio: box.height / canvas.height,
    // Signed, so a caller could tell left from right; the rule uses the magnitude.
    centreOffsetX: ((box.x + box.width / 2) - canvas.width / 2) / canvas.width,
    tiltDegrees: Math.abs(degrees(Math.atan2(rightCentre.y - leftCentre.y, rightCentre.x - leftCentre.x))),
    leftEyeRatio: eyeAspectRatio(leftEye),
    rightEyeRatio: eyeAspectRatio(rightEye)
  }
}

export function evaluateFace (measurements, rules) {
  const r = normalizeFaceRules(rules)
  const findings = []

  if (!r.enabled) return findings
  // Null means the model never loaded. Silence is correct: an infrastructure failure must not
  // present itself to the customer as a problem with their photo.
  if (!measurements) return findings

  const levelFor = rule => (r.blocking || []).includes(rule) ? 'block' : 'warn'

  if (!measurements.faceCount) {
    return [{ rule: 'faceMissing', level: levelFor('faceMissing'), reason: 'faceNotFound' }]
  }

  if (measurements.confidentFaceCount > 1) {
    findings.push({ rule: 'faceMultiple', level: levelFor('faceMultiple'), reason: 'faceMoreThanOne' })
  }

  if (measurements.heightRatio < r.faceMinHeightRatio) {
    findings.push({ rule: 'faceSmall', level: levelFor('faceSmall'), reason: 'faceTooSmall' })
  } else if (measurements.heightRatio > r.faceMaxHeightRatio) {
    findings.push({ rule: 'faceLarge', level: levelFor('faceLarge'), reason: 'faceTooLarge' })
  }

  if (Math.abs(measurements.centreOffsetX) > r.faceMaxCentreOffset) {
    findings.push({ rule: 'faceOffCentre', level: levelFor('faceOffCentre'), reason: 'faceNotCentred' })
  }

  if (measurements.tiltDegrees > r.faceMaxTiltDegrees) {
    findings.push({ rule: 'faceTilted', level: levelFor('faceTilted'), reason: 'faceTilted' })
  }

  // Both eyes must read as closed. One closed eye is more likely a landmark error, a wink, or hair
  // across the face than a genuinely unusable photo.
  const eyes = [measurements.leftEyeRatio, measurements.rightEyeRatio].filter(v => typeof v === 'number')
  if (eyes.length === 2 && eyes.every(v => v < r.eyeOpenMinRatio)) {
    findings.push({ rule: 'eyesClosed', level: levelFor('eyesClosed'), reason: 'faceEyesClosed' })
  }

  // Flat eye regions suggest sunglasses or something else covering the eyes. Null means the region
  // was too small to judge, which is not evidence of anything.
  if (typeof measurements.eyeContrastRatio === 'number' &&
      measurements.eyeContrastRatio < r.eyeContrastMinRatio) {
    findings.push({ rule: 'eyesCovered', level: levelFor('eyesCovered'), reason: 'faceEyesCovered' })
  }

  return findings
}
