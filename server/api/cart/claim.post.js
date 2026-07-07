export default defineEventHandler(async (event) => {
  const userId = getUserIdFromEvent(event)
  if (!userId) throw createError({ statusCode: 401, statusMessage: 'Unauthorized' })

  const body = await readBody(event)
  const cartToken = body?.cartToken
  if (!cartToken || typeof cartToken !== 'string') {
    throw createError({ statusCode: 400, statusMessage: 'cartToken is required' })
  }

  const result = await claimGuestCart(userId, cartToken)
  return result
})
