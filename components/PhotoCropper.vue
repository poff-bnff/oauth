<script setup>
import Cropper from 'cropperjs'
import 'cropperjs/dist/cropper.css'
import { outputSizeFor, minSelectionFor, croppedFileName, DEFAULT_PHOTO_RULES } from '../utils/photoRules.js'
import { measureImageQuality, evaluateImageQuality, hasBlockingFinding } from '../utils/photoQuality.js'
import { measureFace, evaluateFace } from '../utils/photoFace.js'

// Modal that makes the user choose their own 1:1 crop.
//
// Without it, Strapi's `fit: cover` centre-crops every headshot to square on the server, cutting
// the top and bottom off portraits with nobody having chosen that framing.
//
// Chrome (title, buttons) lives here rather than in Cropper.js, which ships none — that is largely
// why it was chosen. Host pages supply the surrounding modal styling via the `variant` prop,
// because the checkout, the Tailwind profile page and the static site share no CSS.

const props = defineProps({
  // Data URL of the image to crop. Null closes the modal.
  src: { type: String, default: null },
  fileName: { type: String, default: 'photo.jpg' },
  // Preserved so the crop of a PNG stays a PNG; anything else is re-encoded as JPEG.
  mimeType: { type: String, default: 'image/jpeg' },
  rules: { type: Object, default: () => DEFAULT_PHOTO_RULES },
  copy: { type: Object, required: true },
  variant: { type: String, default: 'checkout' }
})

const emit = defineEmits(['cropped', 'cancel'])

const imageEl = ref(null)
const busy = ref(false)
// Quality findings for the crop currently on screen. Warnings are shown once and can be accepted;
// a blocking finding cannot be, so `acknowledged` never unlocks it.
const findings = ref([])
const acknowledged = ref(false)
// Set while the face model is downloading, so the button can say so rather than appearing frozen
// for the second or two the 1.5 MB takes on a slow connection.
const checking = ref(false)
let cropper = null

const blocked = computed(() => hasBlockingFinding(findings.value))
const warnings = computed(() => findings.value.filter(f => f.level === 'warn'))
// Second press confirms past warnings. Re-cropping clears the acknowledgement, so the user is not
// silently carried past a warning about a DIFFERENT crop.
const confirmLabel = computed(() => {
  if (checking.value) return props.copy.qualityChecking || props.copy.cropConfirm
  return warnings.value.length && !blocked.value && !acknowledged.value
    ? (props.copy.qualityUseAnyway || props.copy.cropConfirm)
    : props.copy.cropConfirm
})

function destroyCropper () {
  if (cropper) {
    cropper.destroy()
    cropper = null
  }
}

function initCropper () {
  destroyCropper()
  if (!imageEl.value) return

  cropper = new Cropper(imageEl.value, {
    aspectRatio: props.rules?.aspectRatio || 1,
    // viewMode 1 keeps the crop box inside the image, so the user cannot select empty canvas and
    // end up with transparent or black edges in the exported square.
    viewMode: 1,
    autoCropArea: 1,
    background: false,
    movable: true,
    zoomable: true,
    rotatable: false,
    scalable: false,
    responsive: true,
    checkOrientation: true,
    crop: enforceMinimumSelection
  })
}

// Stops the crop box shrinking below minOutputSize in SOURCE pixels, which is what keeps the export
// from ever having to upscale. Cropper's own minCropBoxWidth is in displayed pixels and so drifts
// with zoom and viewport; getData(true) is in the image's own coordinates, which is what matters.
//
// Not recursive in practice: setData re-fires this, but by then the box meets the minimum.
function enforceMinimumSelection () {
  if (!cropper) return

  const image = cropper.getImageData()
  const minimum = minSelectionFor(image.naturalWidth, image.naturalHeight, props.rules)
  const data = cropper.getData(true)

  if (data.width < minimum || data.height < minimum) {
    cropper.setData({
      width: Math.max(data.width, minimum),
      height: Math.max(data.height, minimum)
    })
  }

  // Any change to the selection invalidates findings computed for the previous one.
  if (findings.value.length || acknowledged.value) {
    findings.value = []
    acknowledged.value = false
  }
}

// The <img> is only in the DOM while `src` is set, so build the cropper after it renders and tear
// it down on close. Leaving one alive would keep listeners and a canvas copy of the image around.
watch(() => props.src, async (value) => {
  if (!value) {
    destroyCropper()
    return
  }
  await nextTick()
  initCropper()
})

onBeforeUnmount(destroyCropper)

async function confirm () {
  if (!cropper || busy.value) return
  busy.value = true

  try {
    const data = cropper.getData(true)
    const size = outputSizeFor(data.width, props.rules)

    const canvas = cropper.getCroppedCanvas({
      width: size,
      height: size,
      imageSmoothingQuality: 'high',
      // A JPEG has no alpha channel, so anything transparent would otherwise render black.
      fillColor: '#fff'
    })

    if (!canvas) {
      busy.value = false
      return
    }

    // Measured on the CROPPED canvas, not the source: this is the image that will actually be
    // stored, and a photo can easily be sharp overall while the chosen square is not.
    findings.value = evaluateImageQuality(measureImageQuality(canvas), props.rules?.qualityChecks)

    // Tier 1 first, and only continue if it passed: no point downloading 1.5 MB of model to
    // examine a photo that is already being refused for being blurry.
    if (blocked.value) {
      busy.value = false
      return
    }

    if (props.rules?.faceChecks?.enabled !== false) {
      checking.value = true
      try {
        const face = await measureFace(canvas, props.rules?.faceChecks)
        findings.value = [...findings.value, ...evaluateFace(face, props.rules?.faceChecks)]
      } finally {
        checking.value = false
      }

      if (blocked.value) {
        busy.value = false
        return
      }
    }

    // Warnings are shown first and confirmed on a second press. Subjective judgements — framing,
    // lighting — belong to the user, not to a threshold.
    if (warnings.value.length && !acknowledged.value) {
      acknowledged.value = true
      busy.value = false
      return
    }

    const outputMime = props.mimeType === 'image/png' ? 'image/png' : 'image/jpeg'
    const name = croppedFileName(props.fileName, outputMime)

    // Both shapes are emitted because the surfaces need different ones: the checkout posts a
    // base64 data URL as JSON, while the profile pages append a Blob to FormData.
    canvas.toBlob((blob) => {
      emit('cropped', {
        name,
        data: canvas.toDataURL(outputMime, 0.92),
        blob,
        width: canvas.width,
        height: canvas.height
      })
      busy.value = false
    }, outputMime, 0.92)
  } catch (err) {
    console.warn('[cropper] failed to export crop', err) // eslint-disable-line no-console
    busy.value = false
  }
}

function cancel () {
  destroyCropper()
  emit('cancel')
}
</script>

<template>
  <div v-if="src" class="photo-cropper-layer" :class="`photo-cropper-${variant}`" role="dialog" aria-modal="true">
    <div class="photo-cropper" @click.stop>
      <h3 class="photo-cropper-title">
        {{ copy.cropTitle }}
      </h3>
      <p class="photo-cropper-hint">
        {{ copy.cropInstruction }}
      </p>

      <div class="photo-cropper-stage">
        <img ref="imageEl" :src="src" :alt="copy.cropTitle">
      </div>

      <ul v-if="findings.length" class="photo-cropper-findings">
        <li v-for="finding in findings" :key="finding.rule" :class="finding.level">
          {{ copy[finding.reason] || finding.reason }}
        </li>
      </ul>

      <div class="photo-cropper-actions">
        <button type="button" class="photo-cropper-cancel" :disabled="busy" @click="cancel">
          {{ copy.cropCancel }}
        </button>
        <button type="button" class="photo-cropper-confirm" :disabled="busy || blocked || checking" @click="confirm">
          {{ confirmLabel }}
        </button>
      </div>
    </div>
  </div>
</template>

<style>
/* Unscoped on purpose: the three host contexts (hand-written checkout CSS, Tailwind, Bootstrap)
   supply their own surroundings, but the layer itself must look the same everywhere. */
.photo-cropper-layer {
  position: fixed;
  inset: 0;
  z-index: 2100;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 1rem;
  background: rgba(0, 0, 0, .65);
}

.photo-cropper {
  width: 100%;
  max-width: 32rem;
  max-height: 100%;
  overflow-y: auto;
  padding: 1.25rem;
  border-radius: .5rem;
  background: #fff;
  color: #111;
}

.photo-cropper-title { margin: 0 0 .25rem; font-size: 1.125rem; font-weight: 700; }
.photo-cropper-hint { margin: 0 0 .75rem; font-size: .875rem; opacity: .75; }

/* Cropper.js measures the element it is given, so the stage needs a definite height. */
.photo-cropper-stage { max-height: 60vh; }
.photo-cropper-stage img { display: block; max-width: 100%; }

.photo-cropper-actions {
  display: flex;
  gap: .5rem;
  justify-content: flex-end;
  margin-top: 1rem;
}

.photo-cropper-actions button {
  padding: .5rem 1rem;
  border-radius: .25rem;
  border: 1px solid #111;
  cursor: pointer;
  font: inherit;
}

.photo-cropper-findings { margin: .75rem 0 0; padding: 0; list-style: none; font-size: .875rem; }
.photo-cropper-findings li { padding: .35rem .5rem; border-radius: .25rem; margin-bottom: .25rem; }
.photo-cropper-findings li.block { background: #fdecec; color: #b00020; }
.photo-cropper-findings li.warn { background: #fff6e5; color: #8a5200; }

.photo-cropper-cancel { background: transparent; color: #111; }
.photo-cropper-confirm { background: #111; color: #fff; }
.photo-cropper-actions button[disabled] { opacity: .5; cursor: default; }
</style>
