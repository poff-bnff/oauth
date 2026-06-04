export default defineEventHandler(async (event) => {
  const userId = getUserIdFromEvent(event)
  const query = getQuery(event)
  const context = await getCheckoutContext(userId, query.locale || 'et')
  if (context?.code) throw createError({ statusCode: context.code, statusMessage: context.case, data: context })
  return context
})
