<!-- Sticky right-column order summary shown on all three steps. -->
<script setup>
defineProps({
  cart: { type: Object, required: true },
  vatAmount: { type: Number, required: true },
  copy: { type: Object, required: true }
})

function formatPrice (value) {
  return `${Number(value || 0).toFixed(2)} €`
}

function hasItemImage (item) {
  return Boolean(item.imageUrl)
}

const isOpen = ref(true)
function toggleSummary () {
  isOpen.value = !isOpen.value
}

function isMobile () {
  return window.matchMedia('(max-width: 768px)').matches
}

onMounted(() => {
  if (isMobile()) {
    isOpen.value = false
  }
})
</script>

<template>
  <aside class="order-summary">
    <div class="order-header">
      <div class="order-header-left">
        <h2 class="order-title">
          <svg class="order-icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#f5a623" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
            <path d="M6 2L3 6v14a2 2 0 002 2h14a2 2 0 002-2V6l-3-4z"></path>
            <line x1="3" y1="6" x2="21" y2="6"></line>
            <path d="M16 10a4 4 0 01-8 0"></path>
          </svg>
          {{ copy.order }}
        </h2>
      </div>
      <div class="order-summary-toggle" @click="toggleSummary">
        <strong>{{ formatPrice(cart.total) }}</strong>
        <span class="arrow" :class="{ open: isOpen }">▾</span>
      </div>
    </div>
    <div v-show="isOpen" class="order-body">
      <div v-for="(item, index) in cart.items" :key="`${item.productId}-${item.index ?? index}`" class="summary-item">
        <div class="thumb small">
          <img v-if="hasItemImage(item)" :src="item.imageUrl" :alt="item.title" loading="lazy">
          <span v-else class="thumb-placeholder" aria-hidden="true"></span>
        </div>
        <div>
          <strong>{{ item.title }}</strong>
          <small>1 × {{ formatPrice(item.price) }}</small>
        </div>
        <span>{{ formatPrice(item.price) }}</span>
      </div>
      <div class="summary-lines">
        <div><span>{{ copy.subtotal }}</span><strong>{{ formatPrice(cart.total) }}</strong></div>
        <div><span>{{ copy.vatIncluded }}</span><strong>{{ formatPrice(vatAmount) }}</strong></div>
      </div>
      <div class="summary-total">
        <span>{{ copy.total }}</span>
        <strong>{{ formatPrice(cart.total) }}</strong>
      </div>
    </div>
  </aside>
</template>
