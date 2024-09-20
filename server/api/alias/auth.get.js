import jwt from 'jsonwebtoken'

function hasCompleteProfile(user){
  let profile = user.user_profile
  return profile.email && profile.firstName && profile.lastName && profile.birthdate && profile.phoneNr && profile.gender && profile.picture
}

function getCompleteProfile(user){
  let profile = user.user_profile
  let data = {
    id: profile.id,
    email: profile.email,
    firstname: profile.firstName,
    lastname: profile.lastName,
    birthdate: profile.birthdate,
    phone: profile.phoneNr,
    gender: profile.gender,
    picture: profile.picture.url
  }
  return JSON.stringify(data)
}

export default defineEventHandler(async (event) => {
  const config = useRuntimeConfig()
  const query = getQuery(event)
  const redirectCookie = getCookie(event, 'redirect_uri')
  const stateCookie = getCookie(event, 'state')
  const userCookie = getCookie(event, 'user_token')

  setCookie(event, 'redirect_uri', null)
  setCookie(event, 'user_token', null)

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
    const newUser = await getStrapiUser(strapiUser.id)

    const oldId = await getUserIdFromToken(userCookie)
    const oldUser = await getStrapiUser(oldId)

    if(newUser && oldUser){
      if(newUser.id == oldUser.id){
        setCookie(event, 'state', null)
        return sendRedirect(event, redirectCookie + '&notifier=addAliasExists', 302)
      }
      let hasProfileOld = hasCompleteProfile(oldUser)
      let hasProfileNew = hasCompleteProfile(newUser)
      let profileId = oldUser.user_profile.id

      if(hasProfileOld && hasProfileNew){
        setCookie(event, 'profile_new_cookie', getCompleteProfile(newUser))
        setCookie(event, 'profile_old_cookie', getCompleteProfile(oldUser))

        let params = new URLSearchParams({
          redirect_uri: redirectCookie,
          new_user: newUser.id,
          old_user: oldUser.id,
          state: stateCookie,
        }).toString()
        return sendRedirect(event, config.public.url + '/alias?' + params, 302)

      } else if(hasProfileNew){
        profileId = newUser.user_profile.id
      }
      let params = new URLSearchParams({
        redirect_uri: redirectCookie,
        new_user: newUser.id,
        old_user: oldUser.id,
        profile: profileId,
        state: stateCookie,
      }).toString()
      return sendRedirect(event, config.public.url + '/api/alias/combine?' + params, 302)
    }

    setCookie(event, 'state', null)
    return sendRedirect(event, redirectCookie + '&notifier=addAliasFailed', 302)

  } catch (error) {
    console.error(error)

    throw createError({ statusCode: 500, statusMessage: 'OAuth.ee error' })
  }
})
