async function getOwnBusinessProfile(config, token, id, userId) {
  const params = new URLSearchParams()
  params.append('id', id)
  params.append('_where[user]', userId)

  const profiles = await $fetch(`${config.strapiUrl}/business-profiles?${params.toString()}`, {
    headers: {
      Authorization: `Bearer ${token}`
    }
  })

  return Array.isArray(profiles) ? profiles[0] : null
}

export default defineEventHandler(async (event) => {
  const config = useRuntimeConfig()
  const userId = getUserIdFromEvent(event)
  const adminToken = await getStrapiAdminToken()
  const id = event.context.params.id
  const profile = await getOwnBusinessProfile(config, adminToken, id, userId)

  if (!profile) {
    throw createError({ statusCode: 404, statusMessage: 'Business profile not found' })
  }

  return await $fetch(`${config.strapiUrl}/business-profiles/${id}`, {
    method: 'DELETE',
    headers: {
      Authorization: `Bearer ${adminToken}`
    }
  })
})
