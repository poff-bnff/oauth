export default defineEventHandler(async (event) => {
  const userId = getUserIdFromEvent(event)
  const user = await getStrapiUser(userId)
  if (!user) throw createError({ statusCode: 404, statusMessage: 'Not Found' })

  if (!user.person || Object.keys(user.person).length === 0) {
    console.log(`api::person GET - creating person for user ${userId}`) // eslint-disable-line no-console
    user.person = await createStrapiPerson(user)
  }

  return await getStrapiPerson(user.person.id)
})
