<script setup>
const { url } = useRuntimeConfig()
const { locale, t } = useI18n()
const route = useRoute()
const router = useRouter()
const redirectCookie = useCookie('redirect_uri')
const jwtCookie = useCookie('jwt')

redirectCookie.value = route.query.redirect_uri

locale.value = route.query.locale || 'et'

// signout, if signout url parameter is set
console.log('FOO: route.query', route.query)
if (route.query.signout === null) {
  jwtCookie.value = ''
  console.log('signout')
  router.replace({
    path: '/foo',
    force: true
  })
}

// if jwt cookie is not set, redirect to login page at /
if (!jwtCookie.value) {
  if (route.query.jwt) {
    jwtCookie.value = route.query.jwt
  } else {
    console.log('no jwt cookie')
    console.log('route.query.jwt', route.query.jwt)
    router.replace({
      path: '/',
      query: { redirect_uri: 'http://localhost:3000/foo/?jwt=' }
    })
  }
}
router.replace('/foo')
console.log('jwt in cookie', jwtCookie.value)

// make a http request to /api/profile to get user profile
const profile = await fetch(`${url}/api/profile`, {
  headers: {
    authorization: `Bearer ${jwtCookie.value}`
  }
})
  .then((res) => {
    return res.json()
  })
  .catch((err) => {
    console.log('request failed', err)
  })

console.log({ My: profile?.My?.id })

function getUsername () {
  return profile ? profile.username : 'Jon Doe'
}
function getEmail () {
  return profile ? profile.email : 'john.doe@cem'
}

// fetch cinema list
// with limit=5 and page=1
const limit = 2
const page = 1
const films = await fetch(`${url}/api/cassette?limit=${limit}&page=${page}`, {
  headers: {
    authorization: `Bearer ${jwtCookie.value}`
  }
})
  .then((res) => {
    return res.json()
  })
  .catch((err) => {
    console.log('request failed', err)
  })

console.log('number of films', films.length)

function getFilms () {
  return films
}

watch(
  () => locale.value,
  (value) => {
    router.replace({ query: { ...route.query, locale: value } })
  }
)

</script>

<template>
  <main>
    <!-- logout -->

    <div class="w-full flex items-start justify-between gap-4">
      <a class="signout" href="foo?signout">
        <svg
          class="h-5 w-5 flex"
          xmlns="http://www.w3.org/2000/svg"
          xmlns:xlink="http://www.w3.org/1999/xlink"
          viewBox="0 0 16 16"
        >
          <g fill="none">
            <path
              d="M13.5 8.5a.5.5 0 0 0 0-1H3.803l4.031-3.628a.5.5 0 1 0-.668-.744l-5 4.5a.5.5 0 0 0 0 .744l5 4.5a.5.5 0 1 0 .668-.744L3.803 8.5H13.5z"
              fill="currentColor"
            />
          </g>
        </svg>
        {{ t("signout") }}
      </a>

      <a v-if="locale !== 'en'" @click.prevent="() => (locale = 'en')">EN</a>
      <a v-else @click.prevent="() => (locale = 'et')">ET</a>
    </div>

    <div class="w-full flex flex-col sm:flex-row items-start justify-center gap-14">
      <div class="w-full flex flex-col gap-4">
        <a class="auth">
          {{ getUsername() }}
        </a>
      </div>
      <div class="w-full flex flex-col gap-4">
        <a class="auth">
          {{ getEmail() }}
        </a>
      </div>
    </div>

    <div class="w-full flex flex-col gap-4">
      <table class="w-full">
        <thead>
          <tr>
            <th class="text-left">
              {{ t("film.title") }}
            </th>
            <th class="text-left">
              {{ t("film.synopsis") }}
            </th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="film in getFilms()" :key="film.id" class="">
            <td class="text-left">
              {{ film.title_et }}
            </td>
            <td class="text-left">
              {{ film.synopsis.et }}
            </td>
          </tr>
        </tbody>
      </table>
    </div>
    <div>
      <p>{{ t("info") }}</p>
    </div>
  </main>
</template>

<i18n lang="yaml">
en:
  signout: Log out
  info: Lorem ipsum
  cinema:
    et: Kino
    en: Cinema
    ru: Кино
  film:
    title: Title
    synopsis: Synopsis
et:
  signout: Logi välja
  info: Lorem ipsum
  cinema:
    et: Kino
    en: Cinema
    ru: Кино
  film:
    title: Pealkiri
    synopsis: Kokkuvõte
</i18n>

<style scoped>
main {
  @apply w-full md:w-11/12;
  @apply mx-auto p-8;
  @apply flex flex-col items-center justify-center gap-16;
  font-family: "Fira Sans Extra Condensed", sans-serif;
}

p {
  @apply mb-4 last-of-type:mb-0;
  @apply font-extralight;
  white-space: pre-line;
}

a {
  @apply cursor-pointer;
}

a.signout {
  @apply flex items-center gap-2;
  @apply font-extralight text-xl;
}

a.auth {
  @apply py-2 px-4;
  @apply border border-gray-500;
  @apply hover:text-white hover:bg-orange-400 hover:border-orange-400;
  @apply font-normal;
}
</style>
