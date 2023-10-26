export default defineEventHandler(async (event) => {
  const mainUserId = getUserIdFromEvent(event)
  if (!user) throw createError({ statusCode: 404, statusMessage: 'Not Found' })

  const aliasUserId = await readBody(event)
  return await linkStrapiUser(mainUserId, aliasUserId)
})
