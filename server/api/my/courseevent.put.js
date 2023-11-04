export default defineEventHandler(async (event) => {
  const id = getUserIdFromEvent(event)
  const user = await getStrapiUser(id)
  if (!user) throw createError({ statusCode: 404, statusMessage: 'Not Found' })

  const courseEventId = parseInt(await readBody(event))
  return await setStrapiMyCourseEvent(user, courseEventId)
})
