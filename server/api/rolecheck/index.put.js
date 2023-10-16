export default defineEventHandler(async (event) => {
  const userId = getUserIdFromEvent(event)
  // const user = await getStrapiUser(id)

  const body = await readBody(event)

  body.userId = userId

  console.log('Rolecheck put', body)

  const productToBuy = await roleCheck(body)
  if (!productToBuy) throw createError({ statusCode: 404, statusMessage: 'Not Found' })
  return productToBuy
})
