import jwt from 'jsonwebtoken'

export default defineEventHandler(async (event) => {
  const config = useRuntimeConfig()
  const query = getQuery(event)

  if (!query.code || !query.client_id || !query.client_secret || !query.redirect_uri) {
    throw createError({ statusCode: 400, statusMessage: 'Invalid arguments' })
  }

  const body = {
    client_id: query.client_id,
    client_secret: query.client_secret,
    code: query.code,
    grant_type: 'authorization_code'
  }

  try {
    const { access_token: token } = await $fetch(`${config.public.oauthUrl}/api/token`, { method: 'POST', body })
    const user = await $fetch(`${config.public.oauthUrl}/api/user`, { headers: { Authorization: `Bearer ${token}` } })

    if (!user.email) throw createError({ statusCode: 500, statusMessage: 'No OAuth.ee e-mail' })

    const strapiUser = await authenticateStrapiUser(user.email)
    try {
      const id = getUserIdFromEvent(event)
      console.log(`api::oauth GET - user ${strapiUser.id} (${strapiUser.email}). Old user id ${id}`) // eslint-disable-line no-console
    } catch (error) {
      console.log('api::oauth GET - no old user in session.') // eslint-disable-line no-console
    }

    const jwtData = { ...strapiUser }
    delete jwtData.id

    const jwtToken = jwt.sign(jwtData, config.jwtSecret, { expiresIn: '14d', notBefore: 0, subject: strapiUser.id })

    //return sendRedirect(event, query.redirect_uri + '/?access_token=' + jwtToken, 302)
    return { access_token:jwtToken }
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error(error)

    throw createError(error)
  }
})
