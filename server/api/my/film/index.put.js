export default defineEventHandler(async (event) => {
  const id = getUserIdFromEvent(event)
  const user = await getStrapiUser(id)
  if (!user) throw createError({ statusCode: 404, statusMessage: 'Not Found' })

  const cassetteId = await readBody(event)
  return await setStrapiMyFilm(user, cassetteId)
})
