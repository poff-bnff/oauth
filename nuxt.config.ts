// https://nuxt.com/docs/api/configuration/nuxt-config
export default defineNuxtConfig({
  app: {
    head: {
      htmlAttrs: { lang: 'en' },
      title: 'PÖFF | BNFF',
      link: [
        { rel: 'icon', type: 'image/png', href: '/BNFF-192.png' }
      ]
    }
  },
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
