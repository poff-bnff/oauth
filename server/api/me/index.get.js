export default defineEventHandler(async (event) => {
  const id = getUserIdFromEvent(event)
  console.log('api::me GET - user id', id)
  const user = await getStrapiUser(id)
  console.log('api::me GET - got user', user.id, user.username, user.Me)

  if (!user) throw createError({ statusCode: 404, statusMessage: 'Not Found' })
  return user
})
