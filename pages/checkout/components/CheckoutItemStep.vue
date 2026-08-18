<!--
  Step 1 — per-item detail forms (pickup location, gift owner, pass photo).
  itemForms and brokenImages are reactive objects passed by reference;
  this component mutates them directly (same reactive instance as the parent).
-->
<script setup>
import { emptyCheckoutItemForm, itemKey, isGiftOwnerComplete, isCheckoutItemComplete } from '../composables/useCheckoutProgress.js'
import { savePhoto, deletePhoto } from '../composables/useCheckoutPhotoStore.js'
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
  cart: { type: Object, required: true },
  itemForms: { type: Object, required: true }, // reactive — direct mutation is intentional
  openItemKey: { type: String, default: null },
  brokenImages: { type: Object, required: true }, // reactive — direct mutation is intentional
  removingComponentIds: { type: Object, default: () => new Set() },
  locale: { type: String, default: 'en' },
  copy: { type: Object, required: true }
})

const emit = defineEmits(['update:openItemKey', 'continue', 'error', 'remove', 'progress'])

// ── Utilities ────────────────────────────────────────────────────────────────

function hasConfigurableDetails (item) {
  return Boolean(item.pickupLocations?.length || item.transferable)
}

function ensureItemForm (item, index = 0) {
  const key = itemKey(item, index)
  if (!props.itemForms[key]) {
    props.itemForms[key] = emptyCheckoutItemForm()
  }
  return props.itemForms[key]
}

function isItemComplete (item, index) {
  return isCheckoutItemComplete(item, ensureItemForm(item, index))
}

function isItemOpen (item, index) {
  return hasConfigurableDetails(item) && props.openItemKey === itemKey(item, index)
}

function markImageBroken (item, index) {
  props.brokenImages[itemKey(item, index)] = true
}

function hasItemImage (item, index) {
  return Boolean(item.imageUrl && !props.brokenImages[itemKey(item, index)])
}

function displayText (value) {
  if (!value) return ''
  if (typeof value === 'object') {
    return value[props.locale] || value.et || value.en || value.ru || ''
  }
  return value
}

function locationDescription (location) {
  const raw = location?.raw || {}
  return [
    raw.address, raw.street_name, raw.location_address,
    raw.address_et, raw.address_en, raw.address_ru,
    raw.hall_address, raw.location, raw.description,
    raw.description_et, raw.description_en, raw.description_ru,
    raw.opening_hours, raw.openingHours, raw.hours, raw.worktime, raw.info
  ].map(displayText).filter(Boolean)
    .filter((v, i, arr) => arr.indexOf(v) === i)
    .join(' · ')
}

function pickupSummary (item, index) {
  const form = ensureItemForm(item, index)
  const location = (item.pickupLocations || []).find(l => String(l.id) === String(form.pickupLocationId))
  if (!item.pickupLocations?.length) return props.copy.noPickupNeeded
  return location?.name || props.copy.chooseLocation
}

function ownerSummary (item, index) {
  if (!item.transferable) return props.copy.me
  const form = ensureItemForm(item, index)
  if (form.ownerMode === 'me') return props.copy.me
  if (form.ownerMode === 'gift') {
    return isGiftOwnerComplete(form) ? `Gift to ${form.firstName.trim()}` : 'recipient details needed'
  }
  return props.copy.chooseOwner
}

function ownerNeedsChoice (item, index) {
  if (!item.transferable) return false
  const form = ensureItemForm(item, index)
  if (form.ownerMode === 'me') return false
  if (form.ownerMode === 'gift') return !isGiftOwnerComplete(form)
  return true
}

// ── Handlers ─────────────────────────────────────────────────────────────────

function toggleItem (item, index) {
  if (!hasConfigurableDetails(item)) return
  const key = itemKey(item, index)
  emit('update:openItemKey', props.openItemKey === key ? null : key)
}

function setPickupLocation (item, index, locationId) {
  ensureItemForm(item, index).pickupLocationId = locationId
  emit('progress')
}

function setOwnerMode (item, index, mode) {
  ensureItemForm(item, index).ownerMode = mode
  emit('progress')
}

function toggleOwnerEmail (event, item, index) {
  ensureItemForm(item, index).sendEmail = !event.target.checked
  emit('progress')
}

const photoRules = ref(DEFAULT_PHOTO_RULES)
// Derived from the rules so the picker and the validation cannot disagree.
const photoAccept = computed(() => acceptAttributeFor(photoRules.value))

// One cropper serves every item, so it has to remember which item opened it — `item`/`index` are
// kept to resolve the form again on confirm, since the cart can only be edited on another step.
const crop = reactive({ src: null, name: '', mime: 'image/jpeg', key: null, item: null, index: -1 })

onMounted(async () => {
  photoRules.value = await loadPhotoRules()
})

// Photo rules are shared with the buyer's own photo; only the 1:1 crop is ever stored, never the
// file the user picked.
async function handleOwnerPhoto (event, item, index) {
  const input = event.target
  const file = input.files?.[0]
  if (!file) return
  const form = ensureItemForm(item, index)
  const key = itemKey(item, index)

  const reject = (message) => {
    form.photo = null
    form.photoName = ''
    form.photoError = message
    input.value = ''
    deletePhoto(key)
  }

  let dataUrl = await fileToDataUrl(file)
  let dims = await getImageDimensions(dataUrl)
  let cropMime = file.type
  const check = validateSource(file, dims, photoRules.value)

  if (!check.ok) {
    // A TIFF is converted server-side rather than rejected — the browser cannot decode it, but
    // the cropper only ever sees the resulting JPEG.
    if (!check.convertible) return reject(props.copy[check.reason] || props.copy.photoWrongSize)

    const converted = await convertUnsupportedImage(dataUrl)
    if (!converted) return reject(props.copy.photoWrongFormat)

    dataUrl = converted
    cropMime = 'image/jpeg'
    dims = await getImageDimensions(dataUrl)

    const recheck = validateSource({ type: cropMime, size: dataUrlByteLength(dataUrl) }, dims, photoRules.value)
    if (!recheck.ok) return reject(props.copy[recheck.reason] || props.copy.photoWrongSize)
  }

  form.photoError = ''
  crop.name = file.name
  crop.mime = cropMime
  crop.key = key
  crop.item = item
  crop.index = index
  crop.src = dataUrl

  // Cleared so reselecting the same file still fires `change` after a cancelled crop.
  input.value = ''
}

async function onOwnerPhotoCropped (result) {
  if (!crop.item) return
  const form = ensureItemForm(crop.item, crop.index)
  const key = crop.key

  form.photoError = ''
  form.photoName = result.name
  form.photo = { name: result.name, data: result.data }

  crop.src = null
  crop.item = null

  // MUST mirror the cropped version into IndexedDB. sessionStorage progress snapshots strip photos
  // (serializableCheckoutItemForm), so this store is what a mid-checkout reload restores from —
  // saving the original here would silently resurrect the uncropped image at payment time.
  await savePhoto(key, { name: result.name, data: result.data })
  emit('progress')
}

function onOwnerPhotoCropCancel () {
  crop.src = null
  crop.item = null
}

function validateAndContinue () {
  for (const [index, item] of (props.cart.items || []).entries()) {
    const form = ensureItemForm(item, index)
    if (item.pickupLocations?.length && !form.pickupLocationId) {
      emit('error', props.copy.choosePickup)
      emit('update:openItemKey', itemKey(item, index))
      return
    }
    if (item.transferable && form.ownerMode !== 'me' && form.ownerMode !== 'gift') {
      emit('error', props.copy.chooseOwner)
      emit('update:openItemKey', itemKey(item, index))
      return
    }
    if (item.transferable && form.ownerMode === 'gift' && !isGiftOwnerComplete(form)) {
      emit('error', props.copy.giftFieldsRequired)
      emit('update:openItemKey', itemKey(item, index))
      return
    }
  }
  emit('error', '')
  emit('continue')
}
</script>

<template>
  <div class="step-panel">
    <p class="step-kicker">
      {{ `${copy.stepLabel} 1 / 3 · ${(cart.items || []).filter((item, i) => isItemComplete(item, i)).length} / ${(cart.items || []).length} ${copy.complete}` }}
    </p>
    <h2>{{ copy.details }}</h2>
    <p class="intro">
      {{ copy.needsDetails }}
    </p>

    <article
      v-for="(item, index) in cart.items"
      :key="itemKey(item, index)"
      :class="{ complete: isItemComplete(item, index), open: isItemOpen(item, index), configurable: hasConfigurableDetails(item) }"
      class="item-card"
    >
      <div class="item-header">
        <button class="item-summary" type="button" @click="toggleItem(item, index)">
          <div class="status-circle" aria-hidden="true">
            <span v-if="isItemComplete(item, index)">&#10003;</span>
          </div>
          <div class="thumb">
            <img v-if="hasItemImage(item, index)" :src="item.imageUrl" :alt="item.title" loading="lazy" @error="markImageBroken(item, index)">
            <span v-else class="thumb-placeholder" aria-hidden="true" />
          </div>
          <div class="item-copy">
            <strong>{{ item.title }}</strong>
            <small>
              {{ copy.pickup }}: <span :class="{ missing: item.pickupLocations?.length && !ensureItemForm(item, index).pickupLocationId }">{{ pickupSummary(item, index) }}</span>
              <span v-if="item.transferable"> · {{ copy.owner }}: <span :class="{ missing: ownerNeedsChoice(item, index) }">{{ ownerSummary(item, index) }}</span></span>
            </small>
          </div>
          <span class="item-caret" aria-hidden="true" />
        </button>
        <button
          class="item-remove"
          type="button"
          :aria-label="copy.remove"
          :title="copy.remove"
          :disabled="removingComponentIds.has(item.componentId) || removingComponentIds.size > 0"
          @click="emit('remove', { item, index })"
        >
          <svg v-if="removingComponentIds.has(item.componentId)" class="item-remove-spinner" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <circle cx="12" cy="12" r="10" stroke-dasharray="31.4" stroke-dashoffset="10" />
          </svg>
          <svg v-else width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <polyline points="3 6 5 6 21 6" />
            <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
            <path d="M10 11v6" />
            <path d="M14 11v6" />
            <path d="M9 6V4a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2" />
          </svg>
        </button>
      </div>

      <div v-if="isItemOpen(item, index) && hasConfigurableDetails(item)" class="item-body">
        <!-- Pickup location -->
        <div v-if="item.pickupLocations?.length" class="item-block">
          <h3>{{ copy.pickupLocation }} <span class="required-dot">*</span></h3>
          <button
            v-for="location in item.pickupLocations"
            :key="location.id"
            :class="{ selected: ensureItemForm(item, index).pickupLocationId === location.id }"
            class="location-option"
            type="button"
            @click="setPickupLocation(item, index, location.id)"
          >
            <span class="radio-dot" aria-hidden="true" />
            <span>
              <strong>{{ location.name }}</strong>
              <small v-if="locationDescription(location)">{{ locationDescription(location) }}</small>
            </span>
          </button>
        </div>

        <!-- Transferable owner -->
        <div v-if="item.transferable" class="item-block">
          <h3>{{ copy.owner }} <span class="required-dot">*</span></h3>
          <div class="segmented owner-segmented">
            <button :class="{ active: ensureItemForm(item, index).ownerMode === 'me' }" type="button" @click="setOwnerMode(item, index, 'me')">
              {{ copy.forMe }}
            </button>
            <button :class="{ active: ensureItemForm(item, index).ownerMode === 'gift' }" type="button" @click="setOwnerMode(item, index, 'gift')">
              {{ copy.gift }}
            </button>
          </div>
          <div v-if="ensureItemForm(item, index).ownerMode === 'gift'" class="form-grid owner-form">
            <label><span class="field-label">{{ copy.firstName }} <span class="required-dot">*</span></span><input v-model.trim="ensureItemForm(item, index).firstName" autocomplete="given-name" required></label>
            <label><span class="field-label">{{ copy.lastName }} <span class="required-dot">*</span></span><input v-model.trim="ensureItemForm(item, index).lastName" autocomplete="family-name" required></label>
            <label class="span"><span class="field-label">{{ copy.email }} <span class="required-dot">*</span></span><input v-model.trim="ensureItemForm(item, index).email" type="email" autocomplete="email" placeholder="recipient@example.com" required></label>
            <label class="file photo-upload span">
              <span class="field-label">{{ copy.photo }} <span class="required-dot">*</span></span>
              <input type="file" :accept="photoAccept" @change="handleOwnerPhoto($event, item, index)">
              <span class="photo-upload-box">
                <span class="photo-preview">
                  <img v-if="ensureItemForm(item, index).photo" :src="ensureItemForm(item, index).photo.data" :alt="copy.photo">
                  <template v-else>{{ copy.photoPlaceholder }}</template>
                </span>
                <span class="photo-upload-copy">
                  <strong>{{ ensureItemForm(item, index).photoName || copy.uploadPassPhoto }}</strong>
                  <small>{{ copy.photoHelp }}</small>
                </span>
                <span class="choose-file-button">{{ ensureItemForm(item, index).photoName ? copy.replaceFile : copy.chooseFile }}</span>
              </span>
              <small v-if="ensureItemForm(item, index).photoError" class="photo-error" role="alert">{{ ensureItemForm(item, index).photoError }}</small>
            </label>
            <label class="check owner-notification span">
              <input :checked="!ensureItemForm(item, index).sendEmail" type="checkbox" @change="toggleOwnerEmail($event, item, index)">
              <span>
                <strong>{{ copy.suppressEmail }}</strong>
                <small>{{ copy.suppressEmailHint }}</small>
              </span>
            </label>
          </div>
        </div>
      </div>
    </article>

    <div class="actions">
      <button class="primary" type="button" :disabled="!(cart.items || []).every((item, i) => isItemComplete(item, i))" @click="validateAndContinue">
        {{ copy.continue }} →
      </button>
    </div>

    <!-- One cropper for all items, rendered outside the per-item <label> — a click inside a label
         reopens the file picker. -->
    <PhotoCropper
      :src="crop.src"
      :file-name="crop.name"
      :mime-type="crop.mime"
      :rules="photoRules"
      :copy="copy"
      variant="checkout"
      @cropped="onOwnerPhotoCropped"
      @cancel="onOwnerPhotoCropCancel"
    />
  </div>
</template>
