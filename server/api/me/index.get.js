export default defineEventHandler(async (event) => {
  const id = getUserIdFromEvent(event)
  console.log('api::me GET - user id', id)

  const user = await getStrapiUser(id)

  if (!user) throw createError({ statusCode: 404, statusMessage: 'Not Found' })
  await loadEventivalBadges(user)
  return user
})
