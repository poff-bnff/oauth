export default defineEventHandler(async (event) => {
  const id = getUserIdFromEvent(event)
  console.log('id', id)
  const user = await getStrapiUser(id)

  if (!user) throw createError({ statusCode: 404, statusMessage: 'Not Found' })
  return user
})
