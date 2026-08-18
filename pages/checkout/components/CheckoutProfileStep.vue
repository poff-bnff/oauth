<script setup>
import { isCheckoutProfileComplete } from '../composables/useCheckoutProgress.js'
import { checkoutErrorMessage } from '../../../utils/checkoutErrors.js'
import {
  DEFAULT_PHOTO_RULES,
  acceptAttributeFor,
  convertUnsupportedImage,
  dataUrlByteLength,
  fileToDataUrl,
  getImageDimensions,
  loadPhotoRules,
  validateSource
} from '../../../utils/photoRules.js'

const props = defineProps({
  copy: { type: Object, required: true },
  authHeaders: { type: Object, required: true },
  profile: { type: Object, default: () => ({}) }
})

const emit = defineEmits(['done'])

const saving = ref(false)
const errorMsg = ref('')

const form = reactive({
  firstName: props.profile?.firstName || '',
  lastName: props.profile?.lastName || '',
  email: props.profile?.email || '',
  photo: null,
  photoName: '',
  photoError: ''
})

const hasPicture = computed(() => !!(props.profile?.picture))
const isProfileComplete = computed(() => isCheckoutProfileComplete(form, hasPicture.value))

const photoRules = ref(DEFAULT_PHOTO_RULES)
// Derived from the rules so the picker and the validation cannot disagree.
const photoAccept = computed(() => acceptAttributeFor(photoRules.value))
const crop = reactive({ src: null, name: '', mime: 'image/jpeg' })

onMounted(async () => {
  photoRules.value = await loadPhotoRules()
})

// The chosen file is never stored as-is: it goes to the cropper, and only the 1:1 result is kept.
// Otherwise Strapi's `fit: cover` decides the framing on the server and cuts the head off portraits.
async function handlePhoto (event) {
  const input = event.target
  const file = input.files?.[0]
  if (!file) return

  const reject = (message) => {
    form.photo = null
    form.photoName = ''
    form.photoError = message
    input.value = ''
  }

  let dataUrl = await fileToDataUrl(file)
  let dims = await getImageDimensions(dataUrl)
  let cropMime = file.type
  const check = validateSource(file, dims, photoRules.value)

  if (!check.ok) {
    // A TIFF is not rejected: the browser cannot decode it, but the server can turn it into a
    // JPEG the cropper can show. Everything after this point sees an ordinary JPEG.
    if (!check.convertible) return reject(props.copy[check.reason] || props.copy.photoWrongSize)

    form.photoError = props.copy.photoConverting || ''
    const converted = await convertUnsupportedImage(dataUrl)
    if (!converted) return reject(props.copy.photoWrongFormat)

    dataUrl = converted
    cropMime = 'image/jpeg'
    dims = await getImageDimensions(dataUrl)

    // Re-checked against the converted image: the source minimum applies to what will actually
    // be cropped, and conversion caps very large images.
    const recheck = validateSource({ type: cropMime, size: dataUrlByteLength(dataUrl) }, dims, photoRules.value)
    if (!recheck.ok) return reject(props.copy[recheck.reason] || props.copy.photoWrongSize)
  }

  form.photoError = ''
  crop.name = file.name
  crop.mime = cropMime
  crop.src = dataUrl

  // Cleared so picking the same file again still fires `change` — otherwise a user who cancels the
  // cropper cannot reselect the photo they just chose.
  input.value = ''
}

function onCropped (result) {
  form.photoError = ''
  form.photoName = result.name
  form.photo = { name: result.name, data: result.data }
  crop.src = null
}

function onCropCancel () {
  crop.src = null
}

async function save () {
  errorMsg.value = ''

  if (!form.firstName.trim() || !form.lastName.trim() || !form.email.trim()) {
    errorMsg.value = `${props.copy.firstName}, ${props.copy.lastName} & ${props.copy.email} required`
    return
  }
  if (!form.photo && !hasPicture.value) {
    errorMsg.value = props.copy.photo + ' required'
    return
  }

  saving.value = true
  try {
    await $fetch('/api/checkout/profile', {
      method: 'POST',
      headers: { ...props.authHeaders, 'Content-Type': 'application/json' },
      body: {
        firstName: form.firstName.trim(),
        lastName: form.lastName.trim(),
        email: form.email.trim(),
        photo: form.photo || null
      }
    })
    emit('done')
  } catch (err) {
    console.warn('[checkout] profile save failed', err) // eslint-disable-line no-console
    errorMsg.value = checkoutErrorMessage(err, props.copy, props.copy.checkoutProfileSaveFailed)
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <div class="step-panel profile-step">
    <p class="step-kicker">
      {{ copy.stepLabel }} 1 · {{ copy.yourProfile }}
    </p>
    <h2>{{ copy.yourProfile }}</h2>
    <p class="intro">
      {{ copy.profileIntro }}
    </p>

    <div class="form-grid profile-form">
      <label>
        <span class="field-label">{{ copy.firstName }} <span class="required-dot">*</span></span>
        <input v-model.trim="form.firstName" autocomplete="given-name" required>
      </label>
      <label>
        <span class="field-label">{{ copy.lastName }} <span class="required-dot">*</span></span>
        <input v-model.trim="form.lastName" autocomplete="family-name" required>
      </label>
      <label class="span">
        <span class="field-label">{{ copy.email }} <span class="required-dot">*</span></span>
        <input v-model.trim="form.email" type="email" autocomplete="email" required>
      </label>
      <label class="file photo-upload span">
        <span class="field-label">{{ copy.photo }} <span class="required-dot">*</span></span>
        <input type="file" :accept="photoAccept" @change="handlePhoto">
        <span class="photo-upload-box">
          <span class="photo-preview">
            <img v-if="form.photo" :src="form.photo.data" :alt="copy.photo">
            <template v-else>{{ copy.photoPlaceholder }}</template>
          </span>
          <span class="photo-upload-copy">
            <strong>{{ form.photoName || copy.uploadPassPhoto }}</strong>
            <small>{{ copy.photoHelp }}</small>
          </span>
          <span class="choose-file-button">{{ form.photoName ? copy.replaceFile : copy.chooseFile }}</span>
        </span>
        <small v-if="form.photoError" class="photo-error" role="alert">{{ form.photoError }}</small>
        <small v-if="!form.photo && hasPicture" class="photo-saved">{{ copy.replaceFile }} · photo on file</small>
      </label>
    </div>

    <p v-if="errorMsg" class="profile-error" role="alert">
      {{ errorMsg }}
    </p>

    <div class="actions">
      <button class="primary" type="button" :disabled="saving || !isProfileComplete" @click="save">
        {{ saving ? copy.savingProfile : copy.saveAndContinue }} →
      </button>
    </div>

    <!-- Deliberately outside the <label> above: any click inside a label re-opens the file
         picker, so a cropper nested there would reopen it on every drag. -->
    <PhotoCropper
      :src="crop.src"
      :file-name="crop.name"
      :mime-type="crop.mime"
      :rules="photoRules"
      :copy="copy"
      variant="checkout"
      @cropped="onCropped"
      @cancel="onCropCancel"
    />
  </div>
</template>
