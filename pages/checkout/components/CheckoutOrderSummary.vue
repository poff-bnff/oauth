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
</script>

<template>
  <aside class="order-summary">
    <h2>{{ copy.order }}</h2>
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
  </aside>
</template>
