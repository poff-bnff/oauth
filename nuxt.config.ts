// https://nuxt.com/docs/api/configuration/nuxt-config
export default defineNuxtConfig({
  app: {
    head: {
      htmlAttrs: { lang: 'en' },
      title: 'PÖFF : BNFF',
      meta: [
        { name: 'description', content: 'User Authentication for PÖFF : BNFF' }
      ],
      link: [
        { rel: 'icon', type: 'image/png', href: '/BNFF-192.png' },
        { rel: 'apple-touch-icon', type: 'image/png', href: '/BNFF-57.png' }
      ]
    }
  },
  css: ['~/assets/css/tailwind.css'],
  modules: [
    '@nuxt/devtools',
    '@nuxtjs/i18n',
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
  },
  runtimeConfig: {
    jwtSecret: '',
    strapiUrl: '',
    strapiUser: '',
    strapiPassword: '',
    strapiAdminUser: '',
    strapiAdminPassword: '',
    oauthClientSecret: '',
    eventivalClientSecret: '',
    eventivalApiToken: '',
    fionaApiKey: '',
    public: {
      url: '',
      oauthUrl: '',
      oauthClientId: '',
      eventivalUrl: '',
      eventivalClientId: '',
      eventivalEdition: ''
    }
  }
})
