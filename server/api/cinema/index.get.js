export default defineEventHandler(async (event) => {
  const cinemas = await getStrapiCinemas()

  if (!cinemas) throw createError({ statusCode: 404, statusMessage: 'Not Found' })

  return cinemas
})
