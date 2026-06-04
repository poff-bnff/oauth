import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    setupFiles: ['./tests/setup.js'],
    include: ['tests/**/*.test.{js,ts}']
  },
  resolve: {
    alias: {
      '#imports': '/home/administrator/poff/oauth/tests/__mocks__/nuxt-imports.js'
    }
  }
})
