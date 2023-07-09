// helpful article: https://www.freecodecamp.org/news/handle-file-uploads-on-the-backend-in-node-js-nuxt/

import { setStrapiUserProfile } from '~/server/utils/strapi'

export default defineEventHandler(async (event) => {
  const body = await readMultipartFormData(event)
  const id = getUserIdFromEvent(event)
  const user = await getStrapiUser(id)

  const returnValue = {
    profileId: user.user_profile.id,
    statusCode: 200
  }

  // Add all properties sans picture to profileData
  const profileData = {}
  body.forEach(({ name, data, filename, type }) => {
    if (name !== 'picture') {
      profileData[name] = data.toString()
    }
  })

  // Forward profile to Strapi

  // 1. Upload picture via POST /upload
  const pictureFile = body.find(({ name }) => name === 'picture')
  if (pictureFile) {
    pictureFile.profile_id = user.user_profile.id
    const picture = await uploadStrapiImage(pictureFile)
    if (picture.id) {
      profileData.picture = picture.id
    }
  }
  returnValue.pictureId = profileData.picture.id

  // 2. Update profile via PUT /user-profiles/:id
  try {
    await setStrapiUserProfile(user.user_profile.id, profileData)
    returnValue.body = 'all good, thanks for the all the fish, '.repeat(20) + 'and the dolphins too.'
  } catch (error) {
    throw createError({ statusCode: 500, statusMessage: 'Error setting profile' })
  }

  return returnValue
})
