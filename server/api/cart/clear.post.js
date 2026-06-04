export default defineEventHandler(async (event) => {
  const userId = getUserIdFromEvent(event)
  const cart = await clearCheckoutCart(userId)
  if (cart?.code) throw createError({ statusCode: cart.code, statusMessage: cart.case, data: cart })
  return cart
})
