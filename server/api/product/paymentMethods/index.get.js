export default defineEventHandler(async (event) => {
  const productCatId = getQuery(event).id
  const paymentMethods = await getPaymentMethods(productCatId)
  console.log('Product getPaymentMethods', productCatId)
  if (!paymentMethods) throw createError({ statusCode: 404, statusMessage: 'Not Found' })
  return paymentMethods
})
