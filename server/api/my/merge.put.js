export default defineEventHandler(async (event) => {
  const id = getUserIdFromEvent(event)
  const user = await getStrapiUser(id)
  console.log(`Merging user ${user.id} (${user.email})`)
  if (!user) throw createError({ statusCode: 404, statusMessage: 'Not Found' })

  await loadEventivalBadges(user)

  return user
})
