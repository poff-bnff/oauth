export default defineEventHandler(async (event) => {
  const urlParams = new URLSearchParams(event?.node?.req?.url?.split('?')[1])
  const limit = urlParams.get('limit')
  const page = urlParams.get('page')
  const films = await getStrapiFilms(limit, page)

  if (!films) throw createError({ statusCode: 404, statusMessage: 'Not Found' })

  return films
})
