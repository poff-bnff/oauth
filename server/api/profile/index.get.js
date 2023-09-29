export default defineEventHandler(async (event) => {
  const id = getUserIdFromEvent(event)
  console.log('api::profile GET - user id', id)
  const user = await getStrapiUser(id)

  if (!user) throw createError({ statusCode: 404, statusMessage: 'Not Found' })

  if (user.user_profile === null) {
    // create profile
    console.log('api::profile GET - creating profile for user', id)
    user.user_profile = await createStrapiUserProfile(user)
  }
  return user.user_profile
})
