export default defineEventHandler(async (event) => {
  const config = useRuntimeConfig()
  const userId = getUserIdFromEvent(event)
  const token = await getStrapiAdminToken()
  const params = new URLSearchParams()

  params.append('_where[user]', userId)
  params.append('_where[saved_for_reuse_ne]', false)

  return await $fetch(`${config.strapiUrl}/business-profiles?${params.toString()}`, {
    headers: {
      Authorization: `Bearer ${token}`
    }
  })
})
