import { ref, computed, watch, reactive } from 'vue'
import { vi } from 'vitest'

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
