<!--
  Step 2 — invoice profile: list of saved profiles, edit selected profile, or create a new one.
  invoiceForm is a reactive object passed by reference; v-model bindings mutate it directly.
-->
<script setup>
defineProps({
  copy: { type: Object, required: true },
  invoiceView: { type: String, required: true }, // 'list' | 'selected' | 'create'
  invoiceForm: { type: Object, required: true },  // reactive — direct v-model is intentional
  invoiceFormType: { type: String, required: true }, // 'personal' | 'organisation'
  invoiceFor: { type: String, required: true },   // 'me' | 'someone'
  personalProfiles: { type: Array, required: true },
  organisationProfiles: { type: Array, required: true },
  selectedBillingProfile: { type: Object, default: null },
  saveAsInvoiceProfile: { type: Boolean, required: true },
  savingInvoiceProfile: { type: Boolean, required: true },
  // The saved-profile list could not be read. Distinct from having none: showing "no saved
  // profiles" when we simply could not ask makes a customer think theirs was deleted.
  profilesUnavailable: { type: Boolean, default: false }
})

defineEmits([
  'select-profile',
  'select-invoice-for',
  'start-form',
  'return-to-list',
  'save-new',
  'save-selected',
  'update:saveAsInvoiceProfile',
  'update:invoiceFormType',
  'back',
  'retry-profiles'
])

function profileTitle (profile) {
  return profile.org_name ||
    profile.firstNameLastName ||
    [profile.firstName, profile.lastName].filter(Boolean).join(' ') ||
    `#${profile.id}`
}

function profileEmail (profile) {
  return profile?.email_for_invoice || profile?.email || ''
}

function profileSubtitle (profile) {
  const address = profile.address || {}
  return [
    address.street_name,
    address.add_municipality,
    address.postal_code,
    profile.email_for_invoice,
    profile.phone_nr
  ].filter(Boolean).join(' · ')
}

function isOrganisationProfile (profile) {
  return Boolean(profile?.org_name || profile?.reg_code || profile?.vat_code || profile?.organisation)
}
</script>

<template>
  <div class="step-panel">
    <p class="step-kicker">{{ copy.stepLabel }} 2 / 3 · {{ invoiceView !== 'list' ? copy.taxDocument : copy.chooseSavedProfile }}</p>
    <h2>{{ copy.invoiceDetails }}</h2>

    <div class="invoice-content">
      <div class="invoice-recipient">
        <h3>{{ copy.whoInvoiceFor }}</h3>
        <div class="segmented">
          <button :class="{ active: invoiceFor === 'me' }" type="button" @click="$emit('select-invoice-for', 'me')">{{ copy.forMe }}</button>
          <button :class="{ active: invoiceFor === 'someone' }" type="button" @click="$emit('select-invoice-for', 'someone')">{{ copy.forSomeoneElse }}</button>
        </div>
      </div>

      <!-- Profile list -->
      <div v-if="invoiceView === 'list'" class="profile-list">
        <p class="intro profile-hint">
          You have <strong>{{ personalProfiles.length + organisationProfiles.length }} saved invoice profile(s)</strong>.
          Choose which one to use, or add a new invoice profile.
        </p>

        <div v-if="personalProfiles.length" class="profile-section">
          <div class="section-title">{{ copy.personal }} <span>{{ personalProfiles.length }}</span></div>
          <button v-for="profile in personalProfiles" :key="profile.id" class="profile-row" type="button" @click="$emit('select-profile', profile)">
            <span class="profile-badge">PER</span>
            <span class="profile-row-copy">
              <strong>{{ profileTitle(profile) }}</strong>
              <small>{{ profileSubtitle(profile) }}</small>
            </span>
            <span class="chevron">›</span>
          </button>
        </div>
        <button class="add-row" type="button" @click="$emit('start-form', 'personal', 'me')"><span>+</span>{{ copy.addPersonal }}</button>

        <div v-if="organisationProfiles.length" class="profile-section">
          <div class="section-title">{{ copy.organisation }} <span>{{ organisationProfiles.length }}</span></div>
          <button v-for="profile in organisationProfiles" :key="profile.id" class="profile-row" type="button" @click="$emit('select-profile', profile)">
            <span class="profile-badge org">ORG</span>
            <span class="profile-row-copy">
              <strong>{{ profileTitle(profile) }}</strong>
              <small>{{ profileSubtitle(profile) }}</small>
            </span>
            <span class="chevron">›</span>
          </button>
        </div>
        <button class="add-row" type="button" @click="$emit('start-form', 'organisation', 'me')"><span>+</span>{{ copy.addOrganisation }}</button>
        <p v-if="profilesUnavailable" class="profiles-unavailable">
          {{ copy.savedProfilesUnavailable }}
          <button type="button" class="link-button" @click="$emit('retry-profiles')">{{ copy.tryAgain }}</button>
        </p>
      </div>

      <!-- Edit selected profile -->
      <form v-if="invoiceView === 'selected'" class="invoice-form" @submit.prevent="$emit('save-selected', { continueToPayment: true })">
        <div class="selected-profile-card">
          <span :class="{ org: invoiceFormType === 'organisation' }" class="profile-badge">{{ invoiceFormType === 'organisation' ? 'ORG' : 'PER' }}</span>
          <div class="profile-info">
            <span class="profile-label">{{ copy.savedProfile }}</span>
            <strong>{{ selectedBillingProfile ? profileTitle(selectedBillingProfile) : '' }}</strong>
            <small>{{ selectedBillingProfile ? profileEmail(selectedBillingProfile) : '' }}</small>
          </div>
          <button class="change-button" type="button" @click="$emit('return-to-list')">{{ copy.change }}</button>
        </div>
        <div class="form-grid">
          <template v-if="invoiceFormType === 'organisation'">
            <label class="span"><span class="field-label">{{ copy.companyName }} <span class="required-dot">*</span></span><input v-model.trim="invoiceForm.companyName" required></label>
            <label><span class="field-label">{{ copy.registryCode }} <span class="required-dot">*</span></span><input v-model.trim="invoiceForm.registryCode" required></label>
            <label><span class="field-label">{{ copy.vatNumber }}</span><input v-model.trim="invoiceForm.vatNumber"></label>
            <label class="span"><span class="field-label">{{ copy.contactPerson }} <span class="required-dot">*</span></span><input v-model.trim="invoiceForm.contactPerson" required></label>
          </template>
          <template v-else>
            <label><span class="field-label">{{ copy.firstName }} <span class="required-dot">*</span></span><input v-model.trim="invoiceForm.firstName" autocomplete="given-name" required></label>
            <label><span class="field-label">{{ copy.lastName }} <span class="required-dot">*</span></span><input v-model.trim="invoiceForm.lastName" autocomplete="family-name" required></label>
          </template>
          <template v-if="invoiceFormType === 'organisation'">
            <label class="span"><span class="field-label">{{ copy.address }} <span class="required-dot">*</span></span><input v-model.trim="invoiceForm.address" required></label>
            <label><span class="field-label">{{ copy.city }} <span class="required-dot">*</span></span><input v-model.trim="invoiceForm.city" required></label>
            <label><span class="field-label">{{ copy.postalCode }} <span class="required-dot">*</span></span><input v-model.trim="invoiceForm.postalCode" required></label>
            <label><span class="field-label">{{ copy.country }} <span class="required-dot">*</span></span><input v-model.trim="invoiceForm.country" required></label>
          </template>
          <label class="span"><span class="field-label">{{ copy.email }} <span class="required-dot">*</span></span><input v-model.trim="invoiceForm.email" type="email" autocomplete="email" required></label>
          <label><span class="field-label">{{ copy.phone }}</span><input v-model.trim="invoiceForm.phone" type="tel" autocomplete="tel"></label>
        </div>
        <label class="check save-profile-note">
          <input :checked="saveAsInvoiceProfile" type="checkbox" @change="$emit('update:saveAsInvoiceProfile', $event.target.checked)">
          <span>
            <strong>{{ copy.saveAsProfile }}</strong>
            <small>{{ copy.changesSaved }}</small>
          </span>
        </label>
        <div class="actions split">
          <button class="outline back-button" type="button" @click="$emit('return-to-list')">← {{ copy.back }}</button>
          <button class="primary" type="submit" :disabled="savingInvoiceProfile">{{ savingInvoiceProfile ? '...' : copy.continue + ' →' }}</button>
        </div>
      </form>

      <!-- Create new profile -->
      <form v-if="invoiceView === 'create'" class="invoice-form" @submit.prevent="$emit('save-new', { continueToPayment: true })">
        <div v-if="invoiceFor === 'me'" class="selected-profile-card">
          <span :class="{ org: invoiceFormType === 'organisation' }" class="profile-badge">{{ invoiceFormType === 'organisation' ? 'ORG' : 'PER' }}</span>
          <div class="profile-info">
            <span class="profile-label">{{ copy.newProfile }}</span>
            <small>{{ copy.willBeSaved }}</small>
          </div>
        </div>
        <div v-if="invoiceFor === 'someone'" class="segmented invoice-type-switch">
          <button :class="{ active: invoiceFormType === 'personal' }" type="button" @click="$emit('update:invoiceFormType', 'personal')">{{ copy.personal }}</button>
          <button :class="{ active: invoiceFormType === 'organisation' }" type="button" @click="$emit('update:invoiceFormType', 'organisation')">{{ copy.organisation }}</button>
        </div>
        <div class="form-grid">
          <template v-if="invoiceFormType === 'organisation'">
            <label class="span"><span class="field-label">{{ copy.companyName }} <span class="required-dot">*</span></span><input v-model.trim="invoiceForm.companyName" required></label>
            <label><span class="field-label">{{ copy.registryCode }} <span class="required-dot">*</span></span><input v-model.trim="invoiceForm.registryCode" required></label>
            <label><span class="field-label">{{ copy.vatNumber }}</span><input v-model.trim="invoiceForm.vatNumber"></label>
            <label class="span"><span class="field-label">{{ copy.contactPerson }} <span class="required-dot">*</span></span><input v-model.trim="invoiceForm.contactPerson" required></label>
          </template>
          <template v-else>
            <label><span class="field-label">{{ copy.firstName }} <span class="required-dot">*</span></span><input v-model.trim="invoiceForm.firstName" autocomplete="given-name" required></label>
            <label><span class="field-label">{{ copy.lastName }} <span class="required-dot">*</span></span><input v-model.trim="invoiceForm.lastName" autocomplete="family-name" required></label>
          </template>
          <template v-if="invoiceFormType === 'organisation'">
            <label class="span"><span class="field-label">{{ copy.address }} <span class="required-dot">*</span></span><input v-model.trim="invoiceForm.address" required></label>
            <label><span class="field-label">{{ copy.city }} <span class="required-dot">*</span></span><input v-model.trim="invoiceForm.city" required></label>
            <label><span class="field-label">{{ copy.postalCode }} <span class="required-dot">*</span></span><input v-model.trim="invoiceForm.postalCode" required></label>
            <label><span class="field-label">{{ copy.country }} <span class="required-dot">*</span></span><input v-model.trim="invoiceForm.country" required></label>
          </template>
          <label class="span"><span class="field-label">{{ copy.email }} <span class="required-dot">*</span></span><input v-model.trim="invoiceForm.email" type="email" autocomplete="email" required></label>
          <label><span class="field-label">{{ copy.phone }}</span><input v-model.trim="invoiceForm.phone" type="tel" autocomplete="tel"></label>
        </div>
        <label class="check save-profile-note">
          <input :checked="saveAsInvoiceProfile" type="checkbox" @change="$emit('update:saveAsInvoiceProfile', $event.target.checked)">
          <span>
            <strong>{{ copy.saveAsProfile }}</strong>
            <small>{{ copy.saveAsProfileHint }}</small>
          </span>
        </label>
        <div class="actions split">
          <button class="outline back-button" type="button" @click="$emit('return-to-list')">← {{ copy.back }}</button>
          <button class="primary" type="submit" :disabled="savingInvoiceProfile">{{ savingInvoiceProfile ? '...' : copy.continue + ' →' }}</button>
        </div>
      </form>

      <!-- List-view actions -->
      <div v-if="invoiceView === 'list'" class="actions split">
        <button class="outline back-button" type="button" @click="$emit('back')">← {{ copy.back }}</button>
      </div>
    </div>
  </div>
</template>
