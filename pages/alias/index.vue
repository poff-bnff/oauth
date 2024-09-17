<script setup>

const { url } = useRuntimeConfig().public
const { strapiUrl: uploadsHost } = useRuntimeConfig()
const { locale, t } = useI18n()
const route = useRoute()
const router = useRouter()
const newProfile = useCookie('profile_new_cookie').value
const oldProfile = useCookie('profile_old_cookie').value

locale.value = route.query.locale || 'et'

watch(() => locale.value, (value) => {
  router.replace({ query: { ...route.query, locale: value } })
})

function getCombineUrl (profileId) {
  const query = new URLSearchParams({
    redirect_uri: route.query.redirect_uri,
    new_user: route.query.new_user,
    old_user: route.query.old_user,
    state: route.query.state,
    profile: profileId,
  }).toString()

  return `${url}/api/alias/combine?${query}`
}
</script>

<template>
  <main>
    <div class="w-full flex items-start justify-between gap-4">
      <a class="back" :href="route.query.redirect_uri">
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
      <p>{{ t('info') }}</p>
    </div>

    <div class="w-full flex flex-col sm:flex-row items-start justify-center gap-4">
      <div class="w-full flex flex-col gap-4">
        <a class="auth" :href="getCombineUrl(oldProfile.id)">
          <div class="font-semibold border-b-2 border-dashed border-gray-300 text-center mb-4">{{ t('profile') }} 1</div>
          <div>
            <img class="rounded-full w-32 h-32 mx-auto" :src="uploadsHost + oldProfile.picture" alt="profile1 picture">
          </div>
          <div><span class="font-semibold">{{ t('email') }}: </span>{{ oldProfile.email }}</div>
          <div><span class="font-semibold">{{ t('name') }}: </span>{{ oldProfile.firstname }} {{ oldProfile.lastname }}</div>
          <div><span class="font-semibold">{{ t('phone') }}: </span>{{ oldProfile.phone }}</div>
          <div><span class="font-semibold">{{ t('birthday') }}: </span>{{ oldProfile.birthdate }}</div>
          <div><span class="font-semibold">{{ t('gender') }}: </span>{{ oldProfile.gender }}</div>
        </a>
        <a class="auth" :href="getCombineUrl(newProfile.id)">
          <div class="font-semibold border-b-2 border-dashed border-gray-300 text-center mb-4">{{ t('profile') }} 2</div>
          <div>
            <img class="rounded-full w-32 h-32 mx-auto" :src="uploadsHost + newProfile.picture" alt="profile2 picture">
          </div>
          <div><span class="font-semibold">{{ t('email') }}: </span>{{ newProfile.email }}</div>
          <div><span class="font-semibold">{{ t('name') }}: </span>{{ newProfile.firstname }} {{ newProfile.lastname }}</div>
          <div><span class="font-semibold">{{ t('phone') }}: </span>{{ newProfile.phone }}</div>
          <div><span class="font-semibold">{{ t('birthday') }}: </span>{{ newProfile.birthdate }}</div>
          <div><span class="font-semibold">{{ t('gender') }}: </span>{{ newProfile.gender }}</div>
        </a>
      </div>
    </div>
  </main>
</template>

<i18n lang="yaml">
  en:
    back: Back
    profile: Profile
    name: Name
    email: E-Mail
    phone: Phone
    birthday: Birth Date
    gender: Gender
    info: We found two existing profiles on your accounts. Please choose the one You will keep as your default profile.
  et:
    back: Tagasi
    profile: Profiil
    name: Nimi
    email: E-post
    phone: Telefon
    birthday: Sünnipäev
    gender: Sugu
    info: Leidsime teie kontodelt kaks täidetud ja kehtivat profiili. Palun valige millise soovite jätta alles oma peamise profiilina.
</i18n>

<style scoped>
main {
  @apply w-full md:w-96;
  @apply mx-auto p-8;
  @apply flex flex-col items-center justify-center gap-8;
  font-family: 'Fira Sans Extra Condensed', sans-serif;
}

p {
  @apply mb-4 last-of-type:mb-0;
  @apply font-semibold;
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
