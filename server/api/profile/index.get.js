export default defineEventHandler(async (event) => {
  const headers = getRequestHeaders(event)

  const id = getUserIdFromHeader(headers)
  const user = getStrapiUser(id)

  if (!user) throw createError({ statusCode: 401, statusMessage: 'Unauthorized' })

  return user
})
