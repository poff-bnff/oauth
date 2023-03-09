export default defineEventHandler(async (event) => {
  const id = getUserIdFromEvent(event)
  const user = getStrapiUser(id)

  if (!user) throw createError({ statusCode: 404, statusMessage: 'Not Found' })

  return user
})
