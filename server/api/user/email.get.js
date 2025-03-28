export default defineEventHandler(async (event) => {
  const config = useRuntimeConfig()

  const token = await getAdminBearer(event)

  const query = getQuery(event)

  if (!query.query || query.query == '') {
    throw createError({ statusCode: 400, statusMessage: 'Invalid search' })
  }

  const users = await $fetch(`${config.strapiUrl}/users/?email_contains=${query.query}`, {
    headers: { Authorization: `Bearer ${token}` }
  })

  const results = [...new Map(await Promise.all(users.map(async (user) => {
    const strapiUser = await getStrapiUserForFiona(user.id, token)
    return [strapiUser.id, strapiUser] // Use a Map to ensure uniqueness by ID
  }))).values()]

  return results
})