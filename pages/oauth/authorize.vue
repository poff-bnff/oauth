<script setup>
import crypto from 'crypto'

const { oauthUrl } = useRuntimeConfig().public
const { locale, t } = useI18n()
const route = useRoute()
const router = useRouter()

locale.value = route.query.locale || 'en'

watch(() => locale.value, (value) => {
  router.replace({ query: { ...route.query, locale: value } })
})

function getOauthUrl (provider) {
  var redirect_uri = route.query.redirect_uri
  var state = route.query.state
  var client_id = route.query.client_id

  const query = new URLSearchParams({
    client_id: client_id,
    redirect_uri: redirect_uri,
    response_type: 'code',
    scope: 'openid',
    state: state
  }).toString()

  return `${oauthUrl}/auth/${provider}?${query}`
}

onMounted(async () => {
  const provider = route.query.provider || ''

  switch (provider) {
    case '':
      break
    default:
      await navigateTo(getOauthUrl(provider), { external: true })
      break
  }
})
</script>

<template>
  <main>
    <div class="w-full flex items-start justify-between gap-4">
      <a class="back" href="javascript:history.back()">
        <svg class="h-5 w-5 flex" xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 16 16">
          <g fill="none">
            <path d="M13.5 8.5a.5.5 0 0 0 0-1H3.803l4.031-3.628a.5.5 0 1 0-.668-.744l-5 4.5a.5.5 0 0 0 0 .744l5 4.5a.5.5 0 1 0 .668-.744L3.803 8.5H13.5z" fill="currentColor" />
          </g>
        </svg>
        {{ t('back') }}
      </a>

      <a v-if="locale !== 'en'" @click.prevent="() => locale = 'en'">EN</a>
      <a v-else @click.prevent="() => locale = 'et'">ET</a>
    </div>

    <div>
      <img src="https://assets.poff.ee/img/hunt_oauth_logos.svg" alt="Authenticate" width="100%" height="100%">
    </div>

    <div class="w-full flex flex-col sm:flex-row items-start justify-center gap-4">
      <div class="w-full flex flex-col gap-4">
        <a class="auth" :href="getOauthUrl('apple')">Apple</a>
        <a class="auth" :href="getOauthUrl('google')">Google</a>
        <a class="auth" :href="getOauthUrl('e-mail')">{{ t('email') }}</a>
      </div>
      <div class="w-full flex flex-col gap-4">
        <a class="auth" :href="getOauthUrl('smart-id')">Smart-ID</a>
        <a class="auth" :href="getOauthUrl('mobile-id')">{{ t('mobileid') }}</a>
        <a class="auth" :href="getOauthUrl('id-card')">{{ t('idcard') }}</a>
      </div>
    </div>

    <div class="textcenter">
      <p class="textcenter back">{{ t('info') }}</p>
      <p class="textcenter smaller">{{ t('info2') }}</p>
    </div>
  </main>
</template>

<i18n lang="yaml">
  en:
    back: Back
    idcard: ID-card
    mobileid: Mobile-ID
    email: E-Mail
    info: Select authentication method
    info2: by OAuth.ee
  et:
    back: Tagasi
    idcard: ID-kaart
    mobileid: Mobiil-ID
    email: E-post
    info: Vali autentimismeetod
    info2: OAuth.ee
</i18n>

<style scoped>
main {
  @apply w-full md:w-96;
  @apply mx-auto p-8;
  @apply flex flex-col items-center justify-center gap-16;
  font-family: 'Fira Sans Extra Condensed', sans-serif;
}

p {
  @apply mb-4 last-of-type:mb-0;
  @apply font-extralight;
  white-space: pre-line;
}

a {
  @apply cursor-pointer;
}

a.back {
  @apply flex items-center gap-2;
  @apply font-extralight text-xl;
}

a.auth {
  @apply py-2 px-4 ;
  @apply border border-gray-500;
  @apply hover:text-white hover:bg-orange-400 hover:border-orange-400;
  @apply font-normal;
}
</style>
