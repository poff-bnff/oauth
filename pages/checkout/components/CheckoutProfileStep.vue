<script setup>
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

function fileToDataUrl (file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result)
    reader.onerror = reject
    reader.readAsDataURL(file)
  })
}

function getImageDimensions (src) {
  return new Promise((resolve) => {
    const img = new Image()
    img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight })
    img.onerror = () => resolve(null)
    img.src = src
  })
}

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

  if (!file.type.startsWith('image/')) return reject(props.copy.photoNotImage)
  if (file.size > 5 * 1024 * 1024) return reject(props.copy.photoTooLarge)

  const dataUrl = await fileToDataUrl(file)
  const dims = await getImageDimensions(dataUrl)
  if (!dims || dims.width < 600 || dims.width > 3000 || dims.height < 600 || dims.height > 3000) {
    return reject(props.copy.photoWrongSize)
  }

  form.photoError = ''
  form.photoName = file.name
  form.photo = { name: file.name, data: dataUrl }
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
    errorMsg.value = err?.data?.statusMessage || err?.message || 'Could not save profile'
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
        <input type="file" accept="image/*" @change="handlePhoto">
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
      <button class="primary" type="button" :disabled="saving" @click="save">
        {{ saving ? copy.savingProfile : copy.saveAndContinue }} →
      </button>
    </div>
  </div>
</template>
