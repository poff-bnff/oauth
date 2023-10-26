export default defineEventHandler(async (event) => {
  const userId = getUserIdFromEvent(event)
  // const user = await getStrapiUser(id)
  console.log('api::product/buy PUT - user id', userId)
  const body = await readBody(event)
  console.log('api::product/buy PUT - body', body)

  body.userId = userId

  console.log('api::product/buy PUT', body)

  const productToBuy = await buyProduct(body)
  if (!productToBuy) throw createError({ statusCode: 404, statusMessage: 'Not Found' })
  return productToBuy
})
