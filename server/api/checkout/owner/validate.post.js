export default defineEventHandler(async (event) => {
  const userId = getUserIdFromEvent(event)
  const requestBody = await readBody(event)
  const body = typeof requestBody === 'string' ? JSON.parse(requestBody) : requestBody

  if (!userId) {
    throw createError({ statusCode: 401, statusMessage: 'Unauthorized' })
  }
  if (!body?.categoryId) {
    throw createError({ statusCode: 400, statusMessage: 'Missing product category' })
  }

  const result = await validateCheckoutOwner(userId, body.categoryId, body.owner || {})
  if (result.error) {
    throw createError({
      statusCode: 400,
      statusMessage: result.error,
      data: {
        case: result.error,
        missing: result.missing || [],
        message: ownerValidationMessage(result)
      }
    })
  }

  return result
})

function ownerValidationMessage(result) {
  if (result.error === 'ownerProfileIncomplete') {
    return `This existing user profile is missing: ${(result.missing || []).join(', ')}`
  }
  if (result.error === 'ownerPhotoRequired') return 'Photo is required for a new owner'
  return 'Owner profile is not valid'
}
