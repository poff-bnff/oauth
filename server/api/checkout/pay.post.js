export default defineEventHandler(async (event) => {
  const userId = getUserIdFromEvent(event)
  const body = (await readBody(event)) || {}
  body.ip = body.ip || getRequestIP(event, { xForwardedFor: true }) || event.node.req.socket?.remoteAddress || '127.0.0.1'
  const result = await payCheckoutCart(userId, body || {})
  if (result?.code) throw createError({ statusCode: result.code, statusMessage: result.case, data: result })
  return result
})
