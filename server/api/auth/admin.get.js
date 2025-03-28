export default defineEventHandler(async (event) => {
  const config = useRuntimeConfig()
  const query = getQuery(event)

  if (!query.email || !query.password) {
    throw createError({ statusCode: 400, statusMessage: 'Invalid arguments' })
  }

  try {
    const result = await $fetch(`${config.strapiUrl}/admin/login`, {
      method: 'POST',
      body: {
        email: query.email,
        password: query.password
      }
    })

    const data = {
      token: result.data.token
    }

    return data
  }
  catch(err) {
    return err.data
  }
})