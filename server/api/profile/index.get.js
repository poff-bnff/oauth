export default defineEventHandler(async (event) => {
  const id = getUserIdFromEvent(event)
  console.log('api::profile GET - user id', id)
  const user = await getStrapiUser(id)

  if (!user) throw createError({ statusCode: 404, statusMessage: 'Not Found' })
  return user.user_profile
})
