export default defineEventHandler(async (event) => {
  const userId = getUserIdFromEvent(event)
  // const user = await getStrapiUser(id)
  // console.log('api::product/buy PUT - user id', userId)
  const requestBody = await readBody(event)
  const body = typeof requestBody === 'string' ? JSON.parse(requestBody) : requestBody
  // console.log('api::product/buy PUT - body', body)

  body.userId = userId
  body.ip = body.ip || getRequestIP(event, { xForwardedFor: true }) || event.node.req.socket?.remoteAddress || '127.0.0.1'

  // console.log('api::product/buy PUT', body)

  const productToBuy = await buyProduct(body)
  if (!productToBuy) throw createError({ statusCode: 404, statusMessage: 'Not Found' })
  return productToBuy
})
