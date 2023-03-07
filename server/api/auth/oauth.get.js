export default defineEventHandler(async (event) => {
  const config = useRuntimeConfig()
  const query = getQuery(event)
  const redirectUri = getCookie(event, 'redirect_uri') || '/'
  const stateCookie = getCookie(event, 'state')

  if (!query.code || !query.state || query.state !== stateCookie) {
    throw createError({ statusCode: 401, statusMessage: 'Unauthorized' })
  }

  const body = {
    client_id: config.public.oauthClientId,
    client_secret: config.oauthClientSecret,
    code: query.code,
    grant_type: 'authorization_code',
    state: stateCookie
  }

  try {
    const { access_token: token } = await $fetch('https://oauth.ee/token', { method: 'POST', body })
    const user = await $fetch('https://oauth.ee/user', { headers: { Authorization: `Bearer ${token}` } })

    const jwtToken = jwt.sign({ user }, config.jwtSecret, { expiresIn: '14d' })

    return sendRedirect(event, redirectUri + jwtToken, 302)
  } catch (error) {
    throw createError({ statusCode: 401, statusMessage: 'Unauthorized' })
  }
})
