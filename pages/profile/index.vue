<!-- eslint-disable no-console -->
<script setup>
import { ref } from 'vue'
defineProps(['firstnameInputValue', 'lastnameInputValue', 'profilePicInputValue'])
const firstnameInputValue = ref('J:O:H:N')
const lastnameInputValue = ref('D:O:E')
const profilePicInputValue = ref('https://admin.poff.ee/uploads/U_mihkel_putrin_d286184110.jpeg')

const { url } = useRuntimeConfig()
const { locale, t } = useI18n()
const route = useRoute()
const router = useRouter()
const redirectCookie = useCookie('redirect_uri')
const jwtCookie = useCookie('jwt')

const uploadsHost = 'https://admin.poff.ee'

redirectCookie.value = route.query.redirect_uri

locale.value = route.query.locale || 'et'

// signout, if signout url parameter is set
console.log('PROFILE: route.query', route.query)
if (route.query.signout === null) {
  jwtCookie.value = ''
  console.log('signout')
  router.replace({
    path: '/profile',
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
      query: { redirect_uri: 'http://localhost:3000/profile/?jwt=' }
    })
  }
}
// router.replace('/foo')
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

console.log(profile.user_profile)
console.log({ My: profile?.My?.id })

function getUsername () {
  return profile ? profile.username : 'Jon Doe'
}
function getEmail () {
  return profile ? profile.email : 'john.doe@cem'
}
function getFirstname () {
  return profile?.user_profile?.firstName || 'Jon'
}
function getLastname () {
  return profile?.user_profile?.lastName || 'Doe'
}
firstnameInputValue.value = getFirstname()
lastnameInputValue.value = getLastname()

function onProfilePicChange () {
  console.log('onProfilePicChange')
  console.log(`onProfilePicChange file name: ${profilePicInputValue.value.files[0].name}`)
  console.log(`onProfilePicChange: ${profilePicInputValue.value}`)
}

function submitProfile () {
  console.log(`submitProfile: ${firstnameInputValue.value} ${lastnameInputValue.value}`)
  const formData = new FormData()
  formData.append('firstName', firstnameInputValue.value)
  formData.append('lastName', lastnameInputValue.value)
  formData.append('files.picture', profilePicInputValue.value.files[0], profilePicInputValue.value.files[0].name)
  const headers = {
    'Content-Type': 'multipart/form-data',
    authorization: `Bearer ${jwtCookie.value}`
  }
  const body = formData
  const method = 'PUT'
  const url = '/api/profile'
  const options = { headers, body, method }
  fetch(url, options)
    .then((res) => {
      console.log('submitProfile res', res)
      return res.json()
    })
    .then((data) => {
      console.log('submitProfile data', data)
    })
    .catch((err) => {
      console.log('submitProfile err', err)
    })

  return true
}

// watch locale and update route query
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
      <a class="signout" href="profile?signout">
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

    <div
      class="w-full flex flex-col sm:flex-row items-start justify-center gap-14"
    >
      <!-- thumbnail of profile picture -->
      <div class="w-full flex flex-col gap-4">
        <img
          class="rounded-full w-32 h-32"
          :src="
            uploadsHost +
              profile?.user_profile?.picture?.formats?.thumbnail?.url
          "
          alt="profile picture"
        >
      </div>
      <div class="w-full flex flex-col gap-4">
        <a class="auth">{{ getUsername() }}</a>
      </div>
      <div class="w-full flex flex-col gap-4">
        <a class="auth">{{ getEmail() }}</a>
      </div>
    </div>

    <div class="w-full flex flex-col gap-4">
      <table class="w-full">
        <thead>
          <tr>
            <th class="text-left" colspan="2">
              {{ t("form.title") }}
            </th>
          </tr>
        </thead>
        <tbody>
          <tr class="">
            <td class="text-left">
              {{ t("firstname") }}
            </td>
            <td class="text-left">
              <!-- default value from getFirstname() -->
              <input
                type="text"
                name="firstname"
                class="w-full form-input"
                :value="firstnameInputValue"
              >
            </td>
          </tr>
          <tr class="">
            <td class="text-left">
              {{ t("lastname") }}
            </td>
            <td class="text-left">
              <input
                type="text"
                name="lastname"
                class="w-full form-input"
                :value="lastnameInputValue"
              >
            </td>
          </tr>
          <tr class="">
            <!-- profile picture file upload -->
            <td class="text-left">
              {{ t("picture") }}
            </td>
            <td class="text-left">
              <input
                ref="profilePicInputValue"
                type="file"
                class="w-full form-input"
                name="picture"
                @change="onProfilePicChange"
              >
            </td>
          </tr>
          <!-- submit -->
          <tr class="">
            <td class="text-left" colspan="2">
              <button
                class="w-full btn btn-primary"
                type="submit"
                @click.prevent="submitProfile"
              >
                {{ t("submit") }}
              </button>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  </main>
</template>

<script>
// set default value for firstname input
// const firstname = document.getElementById('input-firstname')
// firstname.value = getFirstname()
</script>

<i18n lang="yaml">
en:
  form:
    title: User Profile
  firstname: Firstname
  lastname: Surname
  email: Email
  picture: Picture
  signout: Log out
  submit: Submit
et:
  form:
    title: Kasutajaprofiil
  firstname: Eesnimi
  lastname: Perekonnanimi
  email: E-post
  picture: Pilt
  signout: Logi välja
  submit: Salvesta
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

.form-input {
  @apply py-2 px-4;
  @apply border border-gray-500;
  @apply hover:text-white hover:bg-orange-400 hover:border-orange-400;
  @apply font-normal;
}

.btn-primary {
  @apply py-2 px-4;
  @apply bg-orange-400;
  @apply hover:bg-orange-500;
  @apply text-white;
  @apply font-normal;
}
</style>
