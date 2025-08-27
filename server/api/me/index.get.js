export default defineEventHandler(async (event) => {
  const id = getUserIdFromEvent(event)
  // console.log('api::me GET - user id', id) // eslint-disable-line no-console

  const user = await getStrapiUser(id)

  if (!user) throw createError({ statusCode: 404, statusMessage: 'Not Found' })
  return user
})
