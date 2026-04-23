// helpful article: https://www.freecodecamp.org/news/handle-file-uploads-on-the-backend-in-node-js-nuxt/

import { setStrapiUserProfile } from '~/server/utils/strapi'
import { logOperational } from '~/server/utils/safeLogger'

export default defineEventHandler(async (event) => {
  const body = await readMultipartFormData(event)
  const userId = getUserIdFromEvent(event)
  const route = 'api::profile PUT'
  const user = await getStrapiUser(userId)

  if (!user) {
    logOperational(event, { route, status: 404, errorCode: 'PROFILE_USER_NOT_FOUND' })
    throw createError({ statusCode: 404, statusMessage: 'Not Found' })
  }

  if (user.user_profile === null) {
    // create profile
    user.user_profile = await createStrapiUserProfile(user)
  }

  const returnValue = {
    profileId: user.user_profile.id,
    statusCode: 200
  }

  // Add all properties sans picture to profileData
  const profileData = {}
  body.forEach(({ name, data }) => {
    if (name !== 'picture') {
      profileData[name] = data.toString()
    }
  })

  const slugify = str => (str || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)+/g, '')
  const pictureFileName = [
    'U',
    slugify(user.user_profile.email),
    user.id
  ].join('_')

  // Forward profile to Strapi

  // 1. Upload picture via POST /upload
  const pictureFile = body.find(({ name }) => name === 'picture')
  if (pictureFile) {
    pictureFile.filename = pictureFileName + '.' + pictureFile.type.split('/')[1]
    pictureFile.profile_id = user.user_profile.id
    const picture = await uploadStrapiImage(pictureFile, 'user-profile', user.user_profile.id)
    if (picture.id) {
      profileData.picture = picture.id
      returnValue.pictureId = picture.id
    }
  }

  // 2. Update profile via PUT /user-profiles/:id
  try {
    await setStrapiUserProfile(user.user_profile.id, profileData)
    returnValue.body = 'all good, thanks for the all the fish, '.repeat(20) + 'and the dolphins too.'
  } catch (error) {
    logOperational(event, { route, status: 500, errorCode: 'PROFILE_UPDATE_FAILED' })
    throw createError({ statusCode: 500, statusMessage: 'Error setting profile' })
  }

  logOperational(event, { route, status: 200 })
  return returnValue
})
