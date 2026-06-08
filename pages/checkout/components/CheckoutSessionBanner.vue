<!--
  Session timer banner (top strip) + debug test-controls strip.
  The expiry warning modal lives in index.vue (outside <main>) to avoid stacking issues.
-->
<script setup>
defineProps({
  tone: { type: String, default: 'normal' }, // normal | yellow | pink | warning
  bannerText: { type: String, required: true },
  display: { type: String, required: true },
  copy: { type: Object, required: true }
})
</script>

<template>
  <div class="session-banner" :class="`session-${tone}`">
    <div class="session-copy">
      <svg class="clock" viewBox="0 0 24 24" aria-hidden="true">
        <circle cx="12" cy="12" r="9" />
        <path d="M12 7v5l3 2" />
      </svg>
      <strong>{{ bannerText }}</strong>
    </div>
    <span class="session-time">
      <span class="session-label">{{ copy.session.toUpperCase() }}</span>
      <span class="session-value">{{ display }}</span>
    </span>
  </div>
</template>
