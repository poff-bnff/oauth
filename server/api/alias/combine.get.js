import jwt from 'jsonwebtoken'

export default defineEventHandler(async (event) => {
  const config = useRuntimeConfig()
  const query = getQuery(event)
  const stateCookie = getCookie(event, 'state')

  setCookie(event, 'state', null)
  setCookie(event, 'profile_new_cookie', null)
  setCookie(event, 'profile_old_cookie', null)

  if (!query.state || query.state !== stateCookie || !query.old_user || !query.new_user || !query.profile || !query.redirect_uri) {
    throw createError({ statusCode: 400, statusMessage: 'Invalid arguments' })
  }


  try {
    const newUser = await getStrapiUser(query.new_user)
    const oldUser = await getStrapiUser(query.old_user)

    let aliases = []
    let profiles = []

    if(!aliases.includes(newUser.id)){
      aliases.push(newUser.id)
    }

    let newProfileId = newUser.user_profile.id
    if(!profiles.includes(newProfileId) && query.profile != newProfileId){
      profiles.push(newProfileId)
    }

    let oldProfileId = oldUser.user_profile.id
    if(!profiles.includes(oldProfileId) && query.profile != oldProfileId){
      profiles.push(oldProfileId)
    }

    newUser.aliasUsers.forEach(alias =>{
      if(alias.id && alias.id != '' && !aliases.includes(alias.id)){
        aliases.push(alias.id)
      }
      if(alias.user_profile && alias.user_profile != '' && !profiles.includes(alias.user_profile) && query.profile != alias.user_profile){
        profiles.push(alias.user_profile)
      }
    })

    oldUser.aliasUsers.forEach(alias =>{
      if(alias.id && alias.id != '' && !aliases.includes(alias.id)){
        aliases.push(alias.id)
      }
      if(alias.user_profile && alias.user_profile != '' && !profiles.includes(alias.user_profile) && query.profile != alias.user_profile){
        profiles.push(alias.user_profile)
      }
    })

    for(const profile of profiles){
      await deleteStrapiUserProfile(profile)
    }

    const userData = {"id":query.old_user, "user_profile":query.profile,"aliasUsers":aliases}
    await setStrapiUser (userData)

    if(query.from_query && query.from_query == 'email_change'){
      return sendRedirect(event, query.redirect_uri + '&notifier=emailChangeSuccess', 302)
    }

    return sendRedirect(event, query.redirect_uri + '&notifier=addAliasSuccess', 302)

  } catch (error) {
    console.error(error)

    throw createError({ statusCode: 500, statusMessage: 'Alias Combine error' })
  }
})
