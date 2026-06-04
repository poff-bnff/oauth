export default defineEventHandler(async (event) => {
  const userId = getUserIdFromEvent(event)
  const query = getQuery(event)
  const cart = await getCheckoutCart(userId, query.locale || 'et')
  if (!cart) return { items: [], total: 0 }
  return cart
})
