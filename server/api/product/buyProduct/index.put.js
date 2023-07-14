export default defineEventHandler(async (event) => {
  const userId = getUserIdFromEvent(event)
  // const user = await getStrapiUser(id)

  const body = await readBody(event)

  body.userId = userId

  console.log('Product productToBuy put', body);

  const productToBuy = await buyProduct(body)
  if (!productToBuy) throw createError({ statusCode: 404, statusMessage: 'Not Found' })
  return productToBuy
})