<!-- eslint-disable no-console -->
<script setup>
import { ref } from 'vue'

defineProps([
  'profileId',
  'firstnameInputValue',
  'lastnameInputValue',
  'profilePicInputValue'
])
const profileId = ref(0)
const firstnameInputValue = ref('J:O:H:N')
const lastnameInputValue = ref('D:O:E')
const profilePicInputValue = ref()

const { url } = useRuntimeConfig()
const { locale, t } = useI18n()
const route = useRoute()
const router = useRouter()
const redirectCookie = useCookie('redirect_uri')
const jwtCookie = useCookie('jwt')

const uploadsHost = 'https://admin.poff.ee'

function startup () {
  redirectCookie.value = route.query.redirect_uri

  locale.value = route.query.locale || 'et'

// signout, if signout url parameter is set
// console.log('PROFILE: route.query', route.query)
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
        query: { redirect_uri: `${url}/profile/?jwt=` }
      })
    }
  }
}; startup()
// console.log('jwt in cookie', jwtCookie.value)

const profile = await fetch(`${url}/api/profile`, {
  headers: { authorization: `Bearer ${jwtCookie.value}` }
})
  .then((res) => { return res.json() })
  .catch((err) => { console.log('request failed', err) })

const profilePic = profile?.user_profile?.picture?.formats?.thumbnail?.url || profile?.user_profile?.picture?.url

console.log('profilePic', profilePic)
const getUsername = () => profile?.username || 'Jon Doe'
const getEmail = () => profile?.email || 'john.doe@cem'

profileId.value = profile?.user_profile?.id
firstnameInputValue.value = profile?.user_profile?.firstName || 'Jon'
lastnameInputValue.value = profile?.user_profile?.lastName || 'Doe'
console.log({ UserProfile: profileId.value, firstName: firstnameInputValue.value, lastName: lastnameInputValue.value })

function onProfilePicChange () {
  const file = profilePicInputValue.value.files[0]
  console.log(`onProfilePicChange file name: ${file.name}`)
  console.log(`onProfilePicChange file type: ${file.type}`)
  console.log(`onProfilePicChange file size: ${file.size}`)
  if (!file.type.startsWith('image/')) {
    console.log('onProfilePicChange file is not an image.')
    return
  }
  if (file.size / 1024 / 1024 > 2) { // 2MB
    console.log('onProfilePicChange file is too big.')
    return
  }
  const reader = new FileReader()
  reader.onload = (e) => {
    const img = new Image()
    img.onload = () => {
      console.log(`onProfilePicChange image width: ${img.width}`)
      console.log(`onProfilePicChange image height: ${img.height}`)
      if (img.width > 2000 || img.height > 2000) {
        console.log('onProfilePicChange image should fit in 2000x2000.')
        return
      }
      console.log('onProfilePicChange image is ok.')
      const profilePicThumbnail = document.getElementById('profilePicThumbnail')
      profilePicThumbnail.src = e.target.result
    }
    img.src = e.target.result
  }
  reader.readAsDataURL(file)
}

function submitProfile () {
  console.log(`submitProfile: ${firstnameInputValue.value} ${lastnameInputValue.value}`)
  const formData = new FormData()
  formData.append('picture', profilePicInputValue.value.files[0])
  const headers = { authorization: `Bearer ${jwtCookie.value}` }
  // const userData = {
  //   firstName: firstnameInputValue.value.value,
  //   lastName: lastnameInputValue.value.value
  // }
  // formData.append('data', JSON.stringify(userData))
  // formData.append('id', profile?.user_profile?.id)
  formData.append('firstName', firstnameInputValue.value.value)
  formData.append('lastName', lastnameInputValue.value.value)
  console.log('Formdata:')
  for (const pair of formData.entries()) {
    console.log(pair[0] + ', ' + pair[1])
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
          id="profilePicThumbnail"
          class="rounded-full w-32 h-32"
          :src="uploadsHost + profilePic"
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
      <form class="w-full flex flex-col gap-4">
        <input type="hidden" name="id" :value="profile?.user_profile?.id">
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
                <input
                  ref="firstnameInputValue"
                  type="text"
                  class="w-full form-input"
                  name="firstname"
                  :value="profile?.user_profile?.firstName"
                >
              </td>
            </tr>
            <tr class="">
              <td class="text-left">
                {{ t("lastname") }}
              </td>
              <td class="text-left">
                <input
                  ref="lastnameInputValue"
                  type="text"
                  class="w-full form-input"
                  name="lastname"
                  :value="profile?.user_profile?.lastName"
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
      </form>
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
