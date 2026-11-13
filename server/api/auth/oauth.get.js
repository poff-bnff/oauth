import jwt from 'jsonwebtoken'
import { createStepTimer } from '../../utils/fiona/stepTimer.js'
import { recordTiming } from '../../utils/fiona/timingLog.js'

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

  const timer = createStepTimer() // how long each step took: read with the `timings` mode of the sync endpoint
  try {
    const { access_token: token } = await timer.step('token exchange (OAuth provider)', () => $fetch(`${config.public.oauthUrl}/api/token`, { method: 'POST', body }))
    const user = await timer.step('user info (OAuth provider)', () => $fetch(`${config.public.oauthUrl}/api/user`, { headers: { Authorization: `Bearer ${token}` } }))

    if (!user.email) throw createError({ statusCode: 500, statusMessage: 'No OAuth.ee e-mail' })

    const strapiUser = await timer.step('Strapi authenticate', () => authenticateStrapiUser(user.email))

    try {
      await timer.step('role sync (Fiona badges + Strapi)', async () => updateUserAndAliasesRoles(await getStrapiUser(strapiUser.id)))
    } catch (error) {
      console.error('api::oauth GET - role sync failed for user', strapiUser.id, error) // eslint-disable-line no-console
    }

    try {
      const id = getUserIdFromEvent(event)
      console.log(`api::oauth GET - user ${strapiUser.id} (${strapiUser.email}). Old user id ${id}`) // eslint-disable-line no-console
    } catch (error) {
      console.log('api::oauth GET - no old user in session.') // eslint-disable-line no-console
    }

    const jwtData = { ...strapiUser }
    delete jwtData.id

    const jwtToken = jwt.sign(jwtData, config.jwtSecret, { expiresIn: '14d', notBefore: 0, subject: strapiUser.id })

    recordTiming({ kind: 'login', userId: strapiUser.id, source: 'oauth', ok: true, ...timer.summary() })
    return sendRedirect(event, redirectUri + jwtToken, 302)
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error(error)

    throw createError({ statusCode: 500, statusMessage: 'OAuth.ee error' })
  }
})
