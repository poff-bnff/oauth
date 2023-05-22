export default defineEventHandler(async (event) => {
  const urlParams = new URLSearchParams(event?.node?.req?.url?.split('?')[1])
  const limit = urlParams.get('limit')
  const page = urlParams.get('page')
  const cassettes = await getStrapiCassettes(limit, page)

  if (!cassettes) throw createError({ statusCode: 404, statusMessage: 'Not Found' })

  return cassettes
})
