<!--
  Step 1 — per-item detail forms (pickup location, gift owner, pass photo).
  itemForms and brokenImages are reactive objects passed by reference;
  this component mutates them directly (same reactive instance as the parent).
-->
<script setup>
import { emptyCheckoutItemForm, itemKey } from '../composables/useCheckoutProgress.js'

const props = defineProps({
  cart: { type: Object, required: true },
  itemForms: { type: Object, required: true }, // reactive — direct mutation is intentional
  openItemKey: { type: String, default: null },
  brokenImages: { type: Object, required: true }, // reactive — direct mutation is intentional
  removingComponentIds: { type: Object, default: () => new Set() },
  locale: { type: String, default: 'en' },
  copy: { type: Object, required: true }
})

const emit = defineEmits(['update:openItemKey', 'continue', 'error', 'remove'])

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

function isGiftOwnerComplete (form) {
  return !!(
    form.firstName.trim() &&
    form.lastName.trim() &&
    /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(form.email.trim()) &&
    form.photo
  )
}

function isItemComplete (item, index) {
  const form = ensureItemForm(item, index)
  if (item.pickupLocations?.length && !form.pickupLocationId) return false
  if (item.transferable && form.ownerMode === 'gift') return isGiftOwnerComplete(form)
  return true
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
  if (form.ownerMode !== 'gift') return props.copy.me
  if (isGiftOwnerComplete(form)) return `Gift to ${form.firstName.trim()}`
  return 'recipient details needed'
}

// ── Handlers ─────────────────────────────────────────────────────────────────

function toggleItem (item, index) {
  if (!hasConfigurableDetails(item)) return
  const key = itemKey(item, index)
  emit('update:openItemKey', props.openItemKey === key ? null : key)
}

function setPickupLocation (item, index, locationId) {
  ensureItemForm(item, index).pickupLocationId = locationId
}

function setOwnerMode (item, index, mode) {
  ensureItemForm(item, index).ownerMode = mode
}

function toggleOwnerEmail (event, item, index) {
  ensureItemForm(item, index).sendEmail = !event.target.checked
}

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

// Same rules as the userprofile photo upload: image type, max 5 MB, 600×600–3000×3000 px.
async function handleOwnerPhoto (event, item, index) {
  const input = event.target
  const file = input.files?.[0]
  if (!file) return
  const form = ensureItemForm(item, index)

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

function validateAndContinue () {
  for (const [index, item] of (props.cart.items || []).entries()) {
    const form = ensureItemForm(item, index)
    if (item.pickupLocations?.length && !form.pickupLocationId) {
      emit('error', props.copy.choosePickup)
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
              <span v-if="item.transferable"> · {{ copy.owner }}: <span :class="{ missing: ensureItemForm(item, index).ownerMode === 'gift' && !isGiftOwnerComplete(ensureItemForm(item, index)) }">{{ ownerSummary(item, index) }}</span></span>
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
              <input type="file" accept="image/*" @change="handleOwnerPhoto($event, item, index)">
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
  </div>
</template>
