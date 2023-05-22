export default defineEventHandler(async (event) => {
  // const token = event?.node?.req?.headers?.authorization?.split(' ')[1]
  // console.log('api.cinema', token)

  // const headers = token ? { Authorization: `Bearer ${token}` } : {}
  // console.log('getStrapiCinemas', headers)
  // return await $fetch('https://admin.poff.ee/cinemas', { headers })

  const cinemas = await getStrapiCinemas()

  if (!cinemas) throw createError({ statusCode: 404, statusMessage: 'Not Found' })

  return cinemas
})
