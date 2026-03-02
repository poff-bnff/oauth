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
  nitro: {
    experimental: {
      // Required for defineTask / scheduledTasks (Nitro ≥ 2.9)
      tasks: true
    },
    scheduledTasks: {
      // Run the Fiona → Strapi sync every 15 minutes.
      // Override via NUXT_NITRO_SCHEDULED_TASKS env var if needed.
      '*/15 * * * *': ['fiona:sync']
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
    syncSecret: '',  // NUXT_SYNC_SECRET — shared secret for POST /api/sync/fiona
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
