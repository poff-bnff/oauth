<script setup>
import crypto from 'crypto'

const { url, eventivalClientId, eventivalUrl, oauthClientId, oauthUrl } = useRuntimeConfig()
const { locale, t } = useI18n()
const route = useRoute()
const router = useRouter()
const redirectCookie = useCookie('redirect_uri')
const stateCookie = useCookie('state')

redirectCookie.value = route.query.redirect_uri

locale.value = route.query.locale || 'et'

if (!stateCookie.value) {
  stateCookie.value = crypto.randomBytes(16).toString('hex')
}

watch(() => locale.value, (value) => {
  router.replace({ query: { ...route.query, locale: value } })
})

function getOauthUrl (provider, isApi) {
  const query = new URLSearchParams({
    client_id: oauthClientId,
    redirect_uri: `${url}/api/auth/oauth`,
    response_type: 'code',
    scope: 'openid',
    state: stateCookie.value
  }).toString()

  return `${oauthUrl}/${isApi ? 'api' : 'auth'}/${provider}?${query}`
}

function getEventivalUrl () {
  const query = new URLSearchParams({
    client_id: eventivalClientId,
    redirect_uri: `${url}/api/auth/eventival`,
    response_type: 'code',
    scope: 'openid',
    state: stateCookie.value
  }).toString()

  return `${eventivalUrl}/auth/realms/Eventival/protocol/openid-connect/auth?${query}`
}
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
    back: Back
    idcard: ID-card
    mobileid: Mobile-ID
    email: E-Mail
    info: |
      This website uses OAuth to enable users to authenticate and connect their accounts with third-party services. By using OAuth, you agree to share your account information, including your name, email address, profile picture, and other relevant details with these services.

      Please note that we do not store any passwords or sensitive information related to your account. The authentication process is handled securely by the third-party service provider.

      You should review the privacy policy and terms of service of any third-party service before connecting your account. We are not responsible for any actions or consequences that may result from your use of these third-party services.

      If you have any questions or concerns about the use of OAuth on this website or application, please contact us.
  et:
    back: Tagasi
    idcard: ID-kaart
    mobileid: Mobiil-ID
    email: E-post
    info: |
      See veebisait kasutab OAuth-i, et võimaldada kasutajatel autentida ja ühendada oma kontod kolmandate teenustega. Kasutades OAuth-i, nõustute oma konto teabe, sealhulgas nime, e-posti aadressi, profiilipildi ja muude asjakohaste üksikasjadega nende teenustega jagamisega.

      Palun pange tähele, et me ei salvesta ühtegi parooli ega tundlikku teavet teie konto kohta. Autentimisprotsessi haldab turvaliselt kolmanda osapoole teenusepakkuja.

      Enne oma konto ühendamist peaksite üle vaatama mis tahes kolmanda osapoole teenuse privaatsuspoliitika ja kasutustingimused. Me ei vastuta nende teenuste kasutamisest tulenevate toimingute või tagajärgede eest.

      Kui teil on selle veebisaidi või rakenduse OAuth-i kasutamisega seotud küsimusi või muresid, võtke meiega ühendust.
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
