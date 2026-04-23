import { logOperational } from '~/server/utils/safeLogger'

export default defineEventHandler(async (event) => {
  const userId = getUserIdFromEvent(event)
  const route = 'api::profile GET'
  const user = await getStrapiUser(userId)

  if (!user) {
    logOperational(event, { route, status: 404, errorCode: 'PROFILE_USER_NOT_FOUND' })
    throw createError({ statusCode: 404, statusMessage: 'Not Found' })
  }

  if (user.user_profile === null) {
    // create profile
    user.user_profile = await createStrapiUserProfile(user)
  }

  logOperational(event, { route, status: 200 })
  return user.user_profile
})
