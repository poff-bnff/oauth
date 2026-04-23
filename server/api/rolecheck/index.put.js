import { logOperational } from '~/server/utils/safeLogger'

export default defineEventHandler(async (event) => {
  const route = 'api::rolecheck PUT'
  const userId = getUserIdFromEvent(event)

  const body = await readBody(event)

  body.userId = userId

  const productToBuy = await roleCheck(body)
  if (!productToBuy) {
    logOperational(event, { route, status: 404, errorCode: 'ROLECHECK_PRODUCT_NOT_FOUND' })
    throw createError({ statusCode: 404, statusMessage: 'Not Found' })
  }

  logOperational(event, { route, status: 200 })
  return productToBuy
})
