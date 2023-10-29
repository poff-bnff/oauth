export default defineEventHandler(async (event) => {
  const id = getUserIdFromEvent(event)
  const user = await getStrapiUser(id)
  if (!user) throw createError({ statusCode: 404, statusMessage: 'Not Found' })

  const screeningId = parseInt(await readBody(event))
  return await setStrapiMyScreening(user, screeningId)
})
