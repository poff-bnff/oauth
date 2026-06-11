export default defineEventHandler(async (event) => {
  const owner = getCartOwner(event)
  const query = getQuery(event)
  const cart = await getCheckoutCart(owner, query.locale || 'et')
  if (!cart) return { items: [], total: 0 }
  return cart
})
