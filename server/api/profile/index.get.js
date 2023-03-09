export default defineEventHandler(async (event) => {
  const id = getUserIdFromEvent(event)

  if (!id) throw createError({ statusCode: 401, statusMessage: 'Unauthorized' })

  const user = getStrapiUser(id)

  if (!user) throw createError({ statusCode: 404, statusMessage: 'Not Found' })

  return user
})
