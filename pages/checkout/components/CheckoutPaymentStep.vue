<!--
  Step 3 — payment method selection + order total summary.
  paymentMethodGroups is pre-grouped by the parent: { label, methods: [{ id, name, logo }] }
-->
<script setup>
defineProps({
  cart: { type: Object, required: true },
  selectedBillingProfile: { type: Object, default: null },
  paymentMethodGroups: { type: Array, required: true },
  paymentMethodId: { type: String, default: '' },
  paying: { type: Boolean, default: false },
  copy: { type: Object, required: true }
})
defineEmits(['update:paymentMethodId', 'pay', 'back'])

function formatPrice (value) {
  return `${Number(value || 0).toFixed(2)} €`
}

function profileTitle (profile) {
  if (!profile) return ''
  return profile.org_name ||
    profile.firstNameLastName ||
    [profile.firstName, profile.lastName].filter(Boolean).join(' ') ||
    `#${profile.id}`
}
</script>

<template>
  <div class="step-panel">
    <p class="step-kicker">{{ copy.stepLabel }} 3 / 3 · {{ copy.confirmPurchase }}</p>
    <h2>{{ copy.payment }}</h2>

    <div class="payment-summary">
      <div>
        <span>{{ copy.itemCount }}</span>
        <strong>{{ (cart.items || []).length }}</strong>
      </div>
      <div v-if="selectedBillingProfile">
        <span>{{ copy.invoiceRecipient }}</span>
        <strong>{{ profileTitle(selectedBillingProfile) }}</strong>
      </div>
      <div class="total">
        <span>{{ copy.total }}</span>
        <strong>{{ formatPrice(cart.total) }}</strong>
      </div>
    </div>

    <template v-for="group in paymentMethodGroups" :key="group.label">
      <h3>{{ group.label }}</h3>
      <div class="payment-grid">
        <button
          v-for="method in group.methods"
          :key="method.id"
          :class="{ selected: paymentMethodId === method.id }"
          type="button"
          @click="$emit('update:paymentMethodId', method.id)"
        >
          <span class="payment-logo-wrap">
            <img v-if="method.logo" :src="method.logo" :alt="method.name" class="payment-logo">
            <span v-else class="payment-dot" aria-hidden="true"></span>
          </span>
          <span class="payment-name">{{ method.name }}</span>
        </button>
      </div>
    </template>

    <div class="actions split">
      <button class="outline back-button" type="button" :disabled="paying" @click="$emit('back')">← {{ copy.back }}</button>
      <button
        class="primary"
        type="button"
        :disabled="!paymentMethodId || paying"
        @click="$emit('pay')"
      >{{ paying ? '...' : `${copy.pay} ${formatPrice(cart.total)}` }}</button>
    </div>
  </div>
</template>
