export default defineEventHandler(async (event) => {
  const userId = getUserIdFromEvent(event)
  const query = getQuery(event)
  return await getCheckoutCategoryAvailability(userId, query.categoryId, query.codePrefix)
})
