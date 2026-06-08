export default defineEventHandler(async () => {
  const config = useRuntimeConfig()
  const token = await getStrapiToken()

  return await $fetch(`${config.strapiUrl}/genders`, {
    headers: {
      Authorization: `Bearer ${token}`
    }
  })
})
