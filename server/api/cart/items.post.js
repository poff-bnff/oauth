export default defineEventHandler(async (event) => {
  try {
    const owner = getCartOwner(event)
    const body = await readBody(event)
    const cart = await addCheckoutCartItem(owner, body || {})
    if (cart?.code) throw createError({ statusCode: cart.code, statusMessage: cart.case, data: cart })
    return cart
  } catch (error) {
    if (error?.statusCode) throw error
    console.error('[cart/items] unexpected add error:', error?.stack || error)
    throw createError({ statusCode: 503, statusMessage: 'addFailed' })
  }
})
