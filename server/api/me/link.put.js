export default defineEventHandler(async (event) => {
  const mainUserId = getUserIdFromEvent(event)
  if (!mainUserId) throw createError({ statusCode: 404, statusMessage: 'Not Found' })

  const aliasUserId = await readBody(event)
  console.log('api::me/link PUT', { mainUserId, aliasUserId })
  return await linkStrapiUser(mainUserId, aliasUserId)
})
