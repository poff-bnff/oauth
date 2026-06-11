export default defineEventHandler(async (event) => {
  const owner = getCartOwner(event)
  const cart = await clearCheckoutCart(owner)
  if (cart?.code) throw createError({ statusCode: cart.code, statusMessage: cart.case, data: cart })
  return cart
})
