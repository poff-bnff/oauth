export default defineEventHandler(async (event) => {
  const config = useRuntimeConfig()
  const token = await getStrapiAdminToken()
  const query = getQuery(event)
  const categoryId = query.id || query.categoryId

  if (!categoryId) return []

  const category = await $fetch(`${config.strapiUrl}/product-categories/${categoryId}`, {
    headers: {
      Authorization: `Bearer ${token}`
    }
  })

  return category?.pickup_locations || []
})
