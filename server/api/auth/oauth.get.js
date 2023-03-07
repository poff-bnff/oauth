import jwt from 'jsonwebtoken'

export default defineEventHandler(async (event) => {
  const config = useRuntimeConfig()
  const query = getQuery(event)
  const redirectUri = getCookie(event, 'redirect_uri') || '/?jwt='
  const stateCookie = getCookie(event, 'state')

  setCookie(event, 'redirect_uri', null)
  setCookie(event, 'state', null)

  if (!query.code || !query.state || query.state !== stateCookie) {
    throw createError({ statusCode: 400, statusMessage: 'Invalid arguments' })
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
    const tokenData = {}

    if (user.name) tokenData.name = user.name

    const jwtToken = jwt.sign(tokenData, config.jwtSecret, { expiresIn: '14d', notBefore: 0, subject: user.email })

    return sendRedirect(event, redirectUri + jwtToken, 302)
  } catch (error) {
    console.error(error)

    throw createError({ statusCode: 500, statusMessage: 'OAuth.ee error' })
  }
})
