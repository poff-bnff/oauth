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
    const { access_token: token } = await $fetch(`${config.public.oauthUrl}/api/token`, { method: 'POST', body })
    const user = await $fetch(`${config.public.oauthUrl}/api/user`, { headers: { Authorization: `Bearer ${token}` } })

    if (!user.email) throw createError({ statusCode: 500, statusMessage: 'No OAuth.ee e-mail' })

    const strapiUser = await authenticateStrapiUser(user.email)

    const jwtData = { ...strapiUser }
    delete jwtData.id

    const jwtToken = jwt.sign(jwtData, config.jwtSecret, { expiresIn: '14d', notBefore: 0, subject: strapiUser.id })

    return sendRedirect(event, redirectUri + jwtToken, 302)
  } catch (error) {
    console.error(error)

    throw createError({ statusCode: 500, statusMessage: 'OAuth.ee error' })
  }
})
