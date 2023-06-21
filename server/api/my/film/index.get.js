// bear in mind, in strapi we have cassettes actually,
// but we call them films to make it more clear for the user

export default defineEventHandler(async (event) => {
  const id = getUserIdFromEvent(event)
  const user = await getStrapiUser(id)
  if (!user) throw createError({ statusCode: 404, statusMessage: 'Not Found' })

  const myCassettes = user.My?.films
  return myCassettes
})
