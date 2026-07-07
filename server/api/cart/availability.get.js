export default defineEventHandler(async (event) => {
  const owner = getCartOwner(event)
  const query = getQuery(event)
  return await getCheckoutCategoryAvailability(owner, query.categoryId, query.codePrefix)
})
