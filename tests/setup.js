import { ref, computed, watch, reactive } from 'vue'
import { vi, beforeEach } from 'vitest'

// Vue reactivity globals (Nuxt auto-imports)
globalThis.ref = ref
globalThis.computed = computed
globalThis.watch = watch
globalThis.reactive = reactive

// Nitro globals
globalThis.defineNitroPlugin = (fn) => fn
globalThis.useRuntimeConfig = () => ({
  public: { url: 'http://localhost:3000' },
  strapiUrl: 'http://localhost:1337',
  strapiUser: 'webuser',
  strapiPassword: 'password',
  strapiAdminUser: 'admin@test.ee',
  strapiAdminPassword: 'password',
  jwtSecret: 'test-secret',
  maksekeskusHost: 'https://api.test.maksekeskus.ee',
  maksekeskusId: 'test-shop-id',
  maksekeskusSecret: 'test-secret'
})
globalThis.$fetch = vi.fn()
globalThis.createError = ({ statusCode, statusMessage, data } = {}) => {
  const err = new Error(statusMessage || 'Error')
  err.statusCode = statusCode
  err.data = data
  return err
}

// Reset module-level checkout caches (e.g. the STEP 4c product-category cache) before every test so a
// cached value can't leak across tests that mock the same category id with different responses.
// Dynamic import so strapi.js (which reads useRuntimeConfig at load) is only evaluated after the
// globals above are set.
beforeEach(async () => {
  try {
    const mod = await import('../server/utils/strapi.js')
    mod.__clearCheckoutCaches?.()
  } catch { /* test doesn't touch strapi utils */ }
})
