export default defineEventHandler(async (event) => {
  const films = await getStrapiFilms()

  if (!films) throw createError({ statusCode: 404, statusMessage: 'Not Found' })

  return films
})
