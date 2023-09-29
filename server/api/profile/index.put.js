// helpful article: https://www.freecodecamp.org/news/handle-file-uploads-on-the-backend-in-node-js-nuxt/

import TableLogger from 'tablelogger'
import { setStrapiUserProfile } from '~/server/utils/strapi'

// console log table with week days
const logTable = new TableLogger({
  border: 'single',
  padding: 1
})

export default defineEventHandler(async (event) => {
  const body = await readMultipartFormData(event)
  const id = getUserIdFromEvent(event)
  console.log('api::profile PUT - user id', id)
  const user = await getStrapiUser(id)

  // logTable.setHeader('Profile from user')
  // for (const [key, value] of Object.entries(user.user_profile)) {
  //   logTable.setRow({ key, value })
  // }
  // logTable.log()

  if (user.profile === null) {
    // create profile
    console.log('api::profile PUT - creating profile for user', id)
    user.user_profile = await createStrapiUserProfile(user)
  }

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

  const slugify = str => str.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)+/g, '')
  const pictureFileName = [
    'U',
    slugify(profileData.firstName || user.user_profile.firstName),
    slugify(profileData.lastName || user.user_profile.lastName),
    user.id
  ].join('-')

  logTable.setHeader('New profile data')
  logTable.setRow({ key: 'user id', value: user.id })
  logTable.setRow({ key: 'profile id', value: user.user_profile.id })
  for (let [key, value] of Object.entries(profileData)) {
    if (value.length > 100) value = `${value.length} bytes...`
    logTable.setRow({ key, value })
  }
  // Forward profile to Strapi

  // 1. Upload picture via POST /upload
  const pictureFile = body.find(({ name }) => name === 'picture')
  logTable.setRow({ key: 'picture', value: pictureFile })
  if (pictureFile) {
    pictureFile.filename = pictureFileName + '.' + pictureFile.type.split('/')[1]
    pictureFile.profile_id = user.user_profile.id
    const picture = await uploadStrapiImage(pictureFile)
    if (picture.id) {
      profileData.picture = picture.id
      returnValue.pictureId = picture.id
    }
    logTable.setRow({ key: 'picture id', value: picture.id })
    for (const [key, value] of Object.entries(pictureFile)) {
      if (key === 'data') continue
      logTable.setRow({ key, value })
    }
  }

  logTable.log()

  // 2. Update profile via PUT /user-profiles/:id
  try {
    await setStrapiUserProfile(user.user_profile.id, profileData)
    returnValue.body = 'all good, thanks for the all the fish, '.repeat(20) + 'and the dolphins too.'
  } catch (error) {
    throw createError({ statusCode: 500, statusMessage: 'Error setting profile' })
  }

  return returnValue
})
