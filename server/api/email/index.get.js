import crypto from 'crypto'
import { isUndeliverableEmail } from '../../../utils/emailRules.js'

function hasCompleteProfile (user) {
  const profile = user.user_profile
  return profile.email && profile.firstName && profile.lastName && profile.birthdate && profile.phoneNr && profile.gender && profile.picture
}

export default defineEventHandler(async (event) => {
  const config = useRuntimeConfig()
  const query = getQuery(event)
  const redirectCookie = getCookie(event, 'redirect_uri')
  const stateCookie = getCookie(event, 'state')
  const userCookie = getCookie(event, 'user_token')

  if (query.user_token) {
    try {
      // One value for both the cookie and the oauth.ee URL. The login callback clears the cookie
      // (sometimes leaving the literal string "null"), so a missing cookie must not be sent on.
      const state = (stateCookie && stateCookie !== 'null') ? stateCookie : crypto.randomBytes(16).toString('hex')
      if (state !== stateCookie) {
        setCookie(event, 'state', state)
      }

      setCookie(event, 'redirect_uri', query.redirect_uri)
      setCookie(event, 'user_token', query.user_token)

      const params = new URLSearchParams({
        client_id: config.public.oauthClientId,
        redirect_uri: `${config.public.url}/api/email`,
        response_type: 'code',
        scope: 'openid',
        state
      }).toString()

      const redirectUri = `${config.public.oauthUrl}/auth/e-mail?${params}`

      return sendRedirect(event, redirectUri, 302)
    } catch (error) {
      console.error(error)
      throw createError({ statusCode: 500, statusMessage: 'Error with redirect' })
    }
  } else if (query.code && query.state && query.state == stateCookie) {
    try {
      setCookie(event, 'redirect_uri', null)
      setCookie(event, 'user_token', null)
      const body = {
        client_id: config.public.oauthClientId,
        client_secret: config.oauthClientSecret,
        code: query.code,
        grant_type: 'authorization_code',
        state: stateCookie
      }

      const { access_token: token } = await $fetch(`${config.public.oauthUrl}/api/token`, { method: 'POST', body })
      const authUser = await $fetch(`${config.public.oauthUrl}/api/user`, { headers: { Authorization: `Bearer ${token}` } })

      if (!authUser.email) throw createError({ statusCode: 500, statusMessage: 'No OAuth.ee e-mail' })

      // The proof can succeed with an eesti.ee address (an ID-card login's own mailbox). Our mail
      // never reaches it, so it must not become the profile email.
      if (isUndeliverableEmail(authUser.email)) {
        setCookie(event, 'state', null)
        return sendRedirect(event, redirectCookie + '&notifier=emailChangeUndeliverable', 302)
      }

      const id = await getUserIdFromToken(userCookie)
      const user = await getStrapiUser(id)

      if (user.user_profile.email && authUser.email == user.user_profile.email) {
        setCookie(event, 'state', null)
        return sendRedirect(event, redirectCookie + '&notifier=emailChangeSame', 302)
      }

      if (await emailInUse(authUser.email)) {
        setCookie(event, 'state', null)
        return sendRedirect(event, redirectCookie + '&notifier=emailChangeTaken', 302)
      }

      const profileBody = { email: authUser.email }
      await setStrapiUserProfile(user.user_profile.id, profileBody)

      const strapiUser = await authenticateStrapiUser(authUser.email)
      const newContact = await getStrapiUser(strapiUser.id)

      if (user.id != newContact.id) {
        const hasProfileOld = hasCompleteProfile(user)
        const hasProfileNew = hasCompleteProfile(newContact)

        let profileId = user.user_profile.id

        if (hasProfileNew && !hasProfileOld) {
          profileId = newContact.user_profile.id
        }

        const params = new URLSearchParams({
          redirect_uri: redirectCookie,
          new_user: newContact.id,
          old_user: user.id,
          profile: profileId,
          state: stateCookie,
          from_query: 'email_change'
        }).toString()
        return sendRedirect(event, config.public.url + '/api/alias/combine?' + params, 302)
      }

      setCookie(event, 'state', null)

      return sendRedirect(event, redirectCookie + '&notifier=emailChangeSuccess', 302)
    } catch (error) {
      console.error(error)
      throw createError({ statusCode: 500, statusMessage: 'Error with email change' })
    }
  }

  throw createError({ statusCode: 400, statusMessage: 'Invalid query' })
})
