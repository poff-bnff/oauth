// https://nuxt.com/docs/api/configuration/nuxt-config
export default defineNuxtConfig({
  css: ['~/assets/css/tailwind.css'],
  modules: [
    ['@nuxtjs/google-fonts', {
      base64: true,
      download: true,
      families: {
        'Fira Sans Extra Condensed': [200, 400]
      }
    }]
  ],
  postcss: {
    plugins: {
      tailwindcss: {},
      autoprefixer: {}
    }
  }
})
