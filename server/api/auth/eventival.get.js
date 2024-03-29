import jwt from 'jsonwebtoken'

export default defineEventHandler(async (event) => {
  const config = useRuntimeConfig()
  const query = getQuery(event)
  const redirectUri = getCookie(event, 'redirect_uri') || '/?jwt='
  const stateCookie = getCookie(event, 'state')

  setCookie(event, 'redirect_uri', null)
  setCookie(event, 'state', null)

  // if (!query.code || !query.state || query.state !== stateCookie) {
  //   throw createError({ statusCode: 400, statusMessage: 'Invalid arguments' })
  // }

  const body = new URLSearchParams({
    client_id: config.public.eventivalClientId,
    client_secret: config.eventivalClientSecret,
    code: query.code,
    grant_type: 'authorization_code',
    redirect_uri: `${config.public.url}/api/auth/eventival`,
    state: stateCookie
  })

  try {
    const { id_token: token } = await $fetch(`${config.public.eventivalUrl}/auth/realms/Eventival/protocol/openid-connect/token`, { method: 'POST', body })
    const user = jwt.decode(token)

    if (!user.email) throw createError({ statusCode: 500, statusMessage: 'No Eventival e-mail' })

    const strapiUser = await authenticateStrapiUser(user.email)

    const jwtData = { ...strapiUser }
    delete jwtData.id

    const jwtToken = jwt.sign(jwtData, config.jwtSecret, { expiresIn: '14d', notBefore: 0, subject: strapiUser.id })

    return sendRedirect(event, redirectUri + jwtToken, 302)
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error(error)

    throw createError({ statusCode: 500, statusMessage: 'Eventival error' })
  }
})
