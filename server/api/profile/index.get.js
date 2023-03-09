export default defineEventHandler(async (event) => {
  const headers = getRequestHeaders(event)

  const id = getUserIdFromHeader(headers)

  if (!id) throw createError({ statusCode: 401, statusMessage: 'Unauthorized' })

  const user = getStrapiUser(id)

  if (!user) throw createError({ statusCode: 404, statusMessage: 'Not Found' })

  return user
})
