// helpful article: https://www.freecodecamp.org/news/handle-file-uploads-on-the-backend-in-node-js-nuxt/

export default defineEventHandler(async (event) => {
  const body = await readMultipartFormData(event)
  console.log('body', body)
  const profileId = parseInt(body.find(({ name }) => name === 'id')?.data.toString())
  if (isNaN(profileId)) {
    throw createError({ statusCode: 400, statusMessage: 'Missing profile ID' })
  }
  console.log('profileId', profileId)

  const id = getUserIdFromEvent(event)
  const user = await getStrapiUser(id)
  console.log('user.profile.id', user.user_profile.id)
  if (profileId !== user.user_profile.id) {
    throw createError({ statusCode: 400, statusMessage: 'Profile ID mismatch' })
  }

  // print out body parts
  body.forEach(({ name, data, filename, type }) => {
    if (name === 'picture') {
      console.log(`name: ${name}, filename: ${filename}, type: ${type}, data: ${data.toString().substr(0, 100)}...`)
      return
    }
    console.log(`name: ${name}, data: ${data.toString()}`)
  })

  return { ok: true }
})
