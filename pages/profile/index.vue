<!-- eslint-disable no-console -->
<script setup>
import { ref } from 'vue'
import TableLogger from 'tablelogger'
import { buildCheckoutCopy } from '../../utils/checkoutCopy.js'
import {
  DEFAULT_PHOTO_RULES,
  acceptAttributeFor,
  convertUnsupportedImage,
  dataUrlByteLength,
  fileToDataUrl,
  getImageDimensions,
  loadPhotoRules,
  validateSource
} from '../../utils/photoRules.js'

const logTable = new TableLogger({
  border: 'single',
  padding: 1
})

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

const { url } = useRuntimeConfig().public
const { strapiUrl: uploadsHost } = useRuntimeConfig()
const { locale, t } = useI18n()
const route = useRoute()
const router = useRouter()
const redirectCookie = useCookie('redirect_uri')
const jwtCookie = useCookie('jwt')

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

const profilePic = profile?.user_profile?.picture?.formats?.thumbnail?.url || profile?.user_profile?.picture?.url || 'N/A'

const getUsername = () => profile?.username || 'Jon Doe'
const getEmail = () => profile?.email || 'john.doe@cem'

profileId.value = profile?.user_profile?.id
firstnameInputValue.value = profile?.user_profile?.firstName || 'Jon'
lastnameInputValue.value = profile?.user_profile?.lastName || 'Doe'

logTable.setHeader('Profile')
logTable.setRow({ key: 'profile picture', value: profilePic })
logTable.setRow({ key: 'Username', value: getUsername() })
logTable.setRow({ key: 'Email', value: getEmail() })
logTable.setRow({ key: 'ProfileId', value: profileId.value })
logTable.setRow({ key: 'Firstname', value: firstnameInputValue.value })
logTable.setRow({ key: 'Lastname', value: lastnameInputValue.value })
logTable.log()

// Photo rules and copy are shared with the checkout rather than duplicated here: same U_ upload,
// same limits, and the strings are already translated into et/en/ru and overridable in Strapi.
const photoCopy = computed(() => buildCheckoutCopy(locale.value))
const photoRules = ref(DEFAULT_PHOTO_RULES)
const photoAccept = computed(() => acceptAttributeFor(photoRules.value))
const photoError = ref('')
const crop = reactive({ src: null, name: '', mime: 'image/jpeg' })

// The 1:1 result, which is what gets uploaded. The raw file in the DOM input is never submitted —
// previously it was, even when validation had rejected it.
const croppedPhoto = ref(null)

onMounted(async () => {
  photoRules.value = await loadPhotoRules()
})

async function onProfilePicChange () {
  const input = profilePicInputValue.value
  const file = input?.files?.[0]
  if (!file) return

  photoError.value = ''
  croppedPhoto.value = null

  let dataUrl = await fileToDataUrl(file)
  let dims = await getImageDimensions(dataUrl)
  let cropMime = file.type
  const check = validateSource(file, dims, photoRules.value)

  const fail = (reason) => {
    // Surfaced to the user, not just logged: the old version console.logged and returned while
    // leaving the file in the input, so submitProfile() uploaded it anyway.
    photoError.value = photoCopy.value[reason] || photoCopy.value.photoWrongSize
    input.value = ''
  }

  if (!check.ok) {
    // TIFF is converted server-side rather than refused; the cropper only sees the JPEG.
    if (!check.convertible) return fail(check.reason)

    const converted = await convertUnsupportedImage(dataUrl)
    if (!converted) return fail('photoWrongFormat')

    dataUrl = converted
    cropMime = 'image/jpeg'
    dims = await getImageDimensions(dataUrl)

    const recheck = validateSource({ type: cropMime, size: dataUrlByteLength(dataUrl) }, dims, photoRules.value)
    if (!recheck.ok) return fail(recheck.reason)
  }

  crop.name = file.name
  crop.mime = cropMime
  crop.src = dataUrl
  input.value = ''
}

function onCropped (result) {
  croppedPhoto.value = result
  photoError.value = ''
  crop.src = null

  const thumbnail = document.getElementById('profilePicThumbnail')
  if (thumbnail) thumbnail.src = result.data
}

function onCropCancel () {
  crop.src = null
}

function submitProfile () {
  // disable submit button while submitting
  const submitButton = document.getElementById('submitButton')
  submitButton.disabled = true

  console.log(`submitProfile: ${firstnameInputValue.value} ${lastnameInputValue.value}`)
  const formData = new FormData()
  // The cropped blob, never profilePicInputValue.files[0] — uploading the raw file would both skip
  // the crop the user just chose and resurrect a file that validation may have rejected.
  if (croppedPhoto.value?.blob) {
    formData.append('picture', croppedPhoto.value.blob, croppedPhoto.value.name)
  }
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
      submitButton.disabled = false
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
      <a class="signout" href="/profile?signout">
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
                  :accept="photoAccept"
                  class="w-full form-input"
                  name="picture"
                  @change="onProfilePicChange"
                >
                <p class="text-sm opacity-75 mt-1">
                  {{ photoCopy.photoHelp }}
                </p>
                <p v-if="photoError" class="text-sm text-red-600 mt-1" role="alert">
                  {{ photoError }}
                </p>
              </td>
            </tr>
            <!-- submit -->
            <tr class="">
              <td class="text-left" colspan="2">
                <button
                  id="submitButton"
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

    <PhotoCropper
      :src="crop.src"
      :file-name="crop.name"
      :mime-type="crop.mime"
      :rules="photoRules"
      :copy="photoCopy"
      variant="profile"
      @cropped="onCropped"
      @cancel="onCropCancel"
    />
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
:disabled {
  @apply bg-gray-400;
  @apply hover:bg-gray-400;
  @apply cursor-not-allowed;
}
</style>
