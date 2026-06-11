export default defineEventHandler(async (event) => {
  const owner = getCartOwner(event)
  const body = (await readBody(event)) || {}
  const cart = await touchCheckoutCartSession(owner, body.locale || 'et')
  if (cart?.code) throw createError({ statusCode: cart.code, statusMessage: cart.case, data: cart })
  return cart
})
