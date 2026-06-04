export default defineEventHandler(async (event) => {
  const userId = getUserIdFromEvent(event)
  const body = (await readBody(event)) || {}
  const cart = await touchCheckoutCartSession(userId, body.locale || 'et')
  if (cart?.code) throw createError({ statusCode: cart.code, statusMessage: cart.case, data: cart })
  return cart
})
