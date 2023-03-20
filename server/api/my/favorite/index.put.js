export default defineEventHandler(async (event) => {
  const id = getUserIdFromEvent(event)
  const user = await getStrapiUser(id)
  const body = await readBody(event)

  if (!user) throw createError({ statusCode: 404, statusMessage: 'Not Found' })

  const myFilms = await setStrapiMyFavorite(user, body.cassetteId)

  return myFilms
})
