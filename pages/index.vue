<script setup>
const { eventivalClientId, oauthClientId } = useRuntimeConfig()
const { locale, t } = useI18n()
const route = useRoute()
const router = useRouter()
const redirectCookie = useCookie('redirect_uri')
const stateCookie = useCookie('state')

redirectCookie.value = route.query.redirect_uri

locale.value = route.query.locale || 'en'

if (!stateCookie.value) {
  stateCookie.value = Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15)
}

watch(() => locale.value, (value) => {
  router.replace({ query: { ...route.query, locale: value } })
})

function getOauthUrl (provider, isApi) {
  const query = new URLSearchParams({
    client_id: oauthClientId,
    redirect_uri: 'https://hunt.poff.ee/api/auth/oauth',
    response_type: 'code',
    scope: 'openid',
    state: stateCookie.value
  }).toString()

  return `https://oauth.ee/${isApi ? 'api' : 'auth'}/${provider}?${query}`
}

function getEventivalUrl () {
  const query = new URLSearchParams({
    client_id: eventivalClientId,
    redirect_uri: 'https://hunt.poff.ee/api/auth/eventival',
    response_type: 'code',
    scope: 'openid',
    state: stateCookie.value
  }).toString()

  return `https://account.eventival.com/auth/realms/Eventival/protocol/openid-connect/auth?${query}`
}
</script>

<template>
  <main>
    <div class="w-full flex items-start justify-between gap-4">
      <a class="back" href="javascript:history.back()">
        <div class="h-5 w-5 flex">
          <svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 16 16"><g fill="none"><path d="M13.5 8.5a.5.5 0 0 0 0-1H3.803l4.031-3.628a.5.5 0 1 0-.668-.744l-5 4.5a.5.5 0 0 0 0 .744l5 4.5a.5.5 0 1 0 .668-.744L3.803 8.5H13.5z" fill="currentColor" /></g></svg>
        </div>
        Back
      </a>
      <a v-if="locale === 'et'" @click.prevent="() => locale = 'en'">EN</a>
      <a v-if="locale === 'en'" @click.prevent="() => locale = 'et'">ET</a>
    </div>

    <div class="w-full flex flex-col sm:flex-row items-start justify-center gap-4">
      <div class="w-full flex flex-col gap-4">
        <a class="auth" :href="getOauthUrl('apple', true)">Apple</a>
        <a class="auth" :href="getOauthUrl('google', true)">Google</a>
        <a class="auth" :href="getEventivalUrl()">Eventival</a>
        <a class="auth" :href="getOauthUrl('e-mail')">{{ t('email') }}</a>
      </div>
      <div class="w-full flex flex-col gap-4">
        <a class="auth" :href="getOauthUrl('smart-id')">Smart-ID</a>
        <a class="auth" :href="getOauthUrl('mobile-id')">{{ t('mobileid') }}</a>
        <a class="auth" :href="getOauthUrl('id-card', true)">{{ t('idcard') }}</a>
      </div>
    </div>

    <div>
      <p>{{ t('info') }}</p>
    </div>
  </main>
</template>

<i18n lang="yaml">
  en:
    idcard: ID-card
    mobileid: Mobile-ID
    email: E-Mail
    info: Lorem ipsum dolor sit amet, consectetur adipiscing elit. Cras nec sodales magna, eget scelerisque odio. Pellentesque felis orci, elementum id egestas eu, molestie ac lacus. Integer felis mauris, condimentum ut pretium sed, dapibus commodo ex.
  et:
    idcard: ID-kaart
    mobileid: Mobiil-ID
    email: E-post
    info: Donec sit amet velit massa. Pellentesque diam urna, vehicula in aliquam eget, egestas at urna. Curabitur egestas risus sit amet dolor tempus fringilla.
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
