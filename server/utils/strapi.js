import crypto from 'crypto'
import jwt from 'jsonwebtoken'

const config = useRuntimeConfig()

const STRAPI_TOKEN = {
  token: null,
  expires: null
}

export async function authenticateStrapiUser (email) {
  if (!email) return null

  const token = await getStrapiToken()

  const [user] = await $fetch(`${config.strapiUrl}/users?email=${email}`, { headers: { Authorization: `Bearer ${token}` } })

  if (user) {
    return getUserObject(user)
  } else {
    const { user: newUser } = await $fetch(`${config.strapiUrl}/auth/local/register`, {
      method: 'POST',
      body: {
        email,
        username: email,
        password: crypto.randomBytes(32).toString('hex')
      }
    })

    return getUserObject(newUser)
  }
}

export async function getEventivalBadges (email) {
  if (!email) return []

  const edition = config.public.eventivalEdition
  const token = config.eventivalApiToken
  const options = {
    headers: {
      'x-api-key': token
    },
    method: 'GET'
  }

  const eUser = await $fetch(`https://bo.eventival.com/poff/${edition}/api/people?account_email=${email}`, options)

  if (!eUser) {
    // console.log('getEventivalBadges eUser is null', email, eUser)
    return []
  }
  if (!Array.isArray(eUser)) {
    // console.log('getEventivalBadges eUser is not array', email, eUser)
    return []
  }
  if (eUser.length === 0) {
    // console.log('getEventivalBadges eUser is empty array', email, eUser)
    return []
  }
  const badges = eUser[0].badges || []
  return badges
    .filter(badge => !badge.cancelled)
    .map(badge => ({
      type: badge.type,
      barcode: badge.barcode,
      validity_dates: badge.validity_dates
    }))
}

export async function getStrapiUser (id, linkedIDs = []) {
  // does not return - modifies user in place
  const mergeFromAliasUsers = async (user) => {
    user.aliasUsers = user.aliasUsers || []
    if (!user.aliasUsers) return
    if (user.aliasUsers.length === 0) return
    let mainUserUpdated = false

      // create My
    if (user.My === null) {
      // eslint-disable-next-line no-console
      console.log('api::getStrapiUser - creating My for user', id)
      user.My = {
        products: [],
        films: [],
        screenings: []
      }
      mainUserUpdated = true
    }

    // Merge values within main user
    if (user.my_films && user.my_films.length > 0) {
      user.My.films = [...(user.My.films || []), ...(user.my_films || [])]
      user.my_films = []
      mainUserUpdated = true
    }
    if (user.my_screenings && user.my_screenings.length > 0) {
      user.My.screenings = [...(user.My.screenings || []), ...(user.my_screenings || [])]
      user.my_screenings = []
      mainUserUpdated = true
    }

    // Merge values from alias users
    for (const aliasUser of user.aliasUsers) {
      let aliasUserUpdated = false
      if (aliasUser.my_products && aliasUser.my_products.length > 0) {
        user.my_products = [...(user.my_products || []), ...(aliasUser.my_products || [])]
        aliasUser.my_products = []
        aliasUserUpdated = mainUserUpdated = true
      }
      if (aliasUser.my_films && aliasUser.my_films.length > 0) {
        user.My.films = [...(user.My.films || []), ...(aliasUser.my_films || [])]
        // aliasUser.my_films = []
        aliasUserUpdated = mainUserUpdated = true
      }
      if (aliasUser.My.films && aliasUser.My.films.length > 0) {
        user.My.films = [...(user.My.films || []), ...(aliasUser.My.films || [])]
        // aliasUser.My.films = []
        aliasUserUpdated = mainUserUpdated = true
      }
      if (aliasUser.my_screenings && aliasUser.my_screenings.length > 0) {
        user.My.screenings = [...(user.My.screenings || []), ...(aliasUser.my_screenings || [])]
        // aliasUser.my_screenings = []
        aliasUserUpdated = mainUserUpdated = true
      }
      if (aliasUser.My.screenings && aliasUser.My.screenings.length > 0) {
        user.My.screenings = [...(user.My.screenings || []), ...(aliasUser.My.screenings || [])]
        // aliasUser.My.screenings = []
        aliasUserUpdated = mainUserUpdated = true
      }
      if (aliasUserUpdated) {
        // Unset the .My and .my_... properties from aliasUser here for cleaner code above
        aliasUser.My = {}
        aliasUser.my_products = []
        aliasUser.my_films = []
        aliasUser.my_screenings = []
        console.log(`api::getStrapiUser - updating alias user ${aliasUser.id}`)
        await setStrapiUser(aliasUser)
      }
    }
    if (mainUserUpdated) {
      user.My.products = user.my_products || []
      console.log(`api::getStrapiUser - updating main user ${user.id}`)
      await setStrapiUser(user)
    }
  }

  if (!id) return null
  const token = await getStrapiToken()
  // eslint-disable-next-line no-console
  console.log(`getStrapiUser, id: ${id}`)

  const user = await $fetch(`${config.strapiUrl}/users/${id}`, {
    headers: { Authorization: `Bearer ${token}` }
  })

  user.aliasUsers = user.aliasUsers || []
  if (user.mainUser && user.aliasUsers && user.aliasUsers.length > 0) {
    const msg = `User ${id} has both mainUser ${user.mainUser.id} and aliasUsers ${user.aliasUsers.map(u => u.id)}`
    console.error(msg)
    throw new Error(msg)
  }

  if (user.mainUser) {
    return getStrapiUser(user.mainUser.id)
  }

  mergeFromAliasUsers(user)

  if (user.user_profile === null) {
    // create profile
    // eslint-disable-next-line no-console
    console.log('api::getStrapiUser - creating profile for user', id)
    user.user_profile = await createStrapiUserProfile(user)
  }

  // collect emails over all users
  user.emails = [user.email]
  for (const aliasUser of user.aliasUsers) {
    if (!aliasUser.email) continue
    user.emails.push(aliasUser.email)
  }
  console.log(`api::getStrapiUser - collected emails for user ${user.id} emails ${user.emails}`)
  // fetch badges from eventival
  // user.badges = []
  // for (email of user.emails) {
  //   const badges = await getEventivalBadges(email)
  //   user.badges = [...user.badges, ...badges]
  // }

  // remove properties with null values from profile
  Object.keys(user.user_profile).forEach(key => user.user_profile[key] === null && delete user.user_profile[key])
  Object.keys(user).forEach(key => user[key] === null && delete user[key])

  return user
}

export async function setStrapiUser (user) {
  if (!user) return null
  const token = await getStrapiToken()
  const id = `${user.id}`
  user.id = id
  console.log(`setStrapiUser, id: ${id}`)
  return await $fetch(`${config.strapiUrl}/users-permissions/users/${id}`, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: user
  })
}

export async function createStrapiUserProfile (user) {
  if (!user) return null
  const token = await getStrapiToken()
  const userProfile = {
    user: user.id,
    email: user.email
  }
  // eslint-disable-next-line no-console
  console.log('createStrapiUserProfile', userProfile)

  return await $fetch(`${config.strapiUrl}/user-profiles`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: userProfile
  })
}

export async function setStrapiUserProfile (profileId, body) {
  if (!profileId) return new Error('No profile ID provided. Endpoint: "/user-profiles/:id"')
  if (!body) return null
  body.id = profileId
  const token = await getStrapiToken()

  return await $fetch(`${config.strapiUrl}/user-profiles/${profileId}`, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body
  })
}

export async function uploadStrapiImage (file) {
  if (!file) return null

  const token = await getStrapiToken()
  const formData = new FormData()

  const { name, filename, data: databuff, profileId } = file
  const blob = new Blob([databuff])

  formData.append('files', blob, filename)
  formData.append('ref', 'user-profile')
  formData.append('refId', profileId)
  formData.append('field', name)
  try {
    const pics = await $fetch(`${config.strapiUrl}/upload`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: formData
    })
    return pics[0]
  } catch (error) {
    throw new Error(error)
  }
}

export async function setStrapiMyFilm (user, cassetteId) {
  if (!cassetteId) return null
  if (!user) return null

  const token = await getStrapiToken()
  const my = user.My || { films: [] }
  const myFilms = (my.films || []).map(film => ({ id: film.id }))

  // If the cassette was already in the user's favorites, remove it. Otherwise, add it.
  const index = myFilms.findIndex(film => film.id === cassetteId)
  if (index > -1) {
    myFilms.splice(index, 1)
  } else {
    myFilms.push({ id: cassetteId })
  }

  my.films = myFilms

  // TODO: Use setStrapiMy
  // Update user's favorites list
  const result = await $fetch(`${config.strapiUrl}/users/${user.id}`, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: {
      id: user.id,
      My: my
    }
  })

  return result.My
}

export async function setStrapiMy (user) {
  if (!user) return null
  user.My = user.My || {}

  const token = await getStrapiToken()

  const result = await $fetch(`${config.strapiUrl}/users/${user.id}`, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: {
      id: user.id,
      My: user.My,
      my_products: user.my_products || [],
      my_films: user.my_films || [],
      my_screenings: user.my_screenings || []
    }
  })

  return result.My
}

export async function setFavorites (user, favorites) {
  if (!favorites) return null
  if (!user) return null

  const token = await getStrapiToken()

  favorites.userId = user.id

  // console.log('setFavorites', favorites)

  // Update user's favorites list
  const result = await $fetch(`${config.strapiUrl}/users/favorites/`, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: favorites
  })

  return result.My
}

export async function setStrapiMyScreening (user, screeningId) {
  if (!screeningId) return null
  if (!user) return null

  const token = await getStrapiToken()
  const my = user.My || { screenings: [] }
  const myScreenings = (my.screenings || []).map(screening => ({ id: screening.id }))

  // If the screening was already in the user's screenings, remove it. Otherwise, add it.
  const index = myScreenings.findIndex(screening => screening.id === screeningId)
  if (index > -1) {
    myScreenings.splice(index, 1)
  } else {
    myScreenings.push({ id: screeningId })
  }

  my.screenings = myScreenings

  // TODO: Use setStrapiMy
  // Update user's screenings list
  const result = await $fetch(`${config.strapiUrl}/users/${user.id}`, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: {
      id: user.id,
      My: my
    }
  })

  return result.My
}

export function getUserIdFromEvent (event) {
  const headers = getRequestHeaders(event)

  const token = headers?.authorization?.split(' ')[1]

  if (!token) throw createError({ statusCode: 401, statusMessage: 'Unauthorized' })

  try {
    const { sub } = jwt.verify(token, config.jwtSecret)
    return parseInt(sub)
  } catch (error) {
    throw createError({ statusCode: 401, statusMessage: 'Invalid token' })
  }
}

async function getStrapiToken () {
  // If a cached token exists, and it's not expired, return it
  if (STRAPI_TOKEN.token && STRAPI_TOKEN.expires > Date.now()) {
    return STRAPI_TOKEN.token
  } else {
    return await refreshStrapiToken()
  }
}

async function refreshStrapiToken () {
  const { jwt: token } = await $fetch(`${config.strapiUrl}/auth/local`, {
    method: 'POST',
    body: {
      identifier: config.strapiUser,
      password: config.strapiPassword
    }
  })
  STRAPI_TOKEN.token = token
  // Read expiration from token and subtract 5 minutes
  STRAPI_TOKEN.expires = (jwt.decode(token).exp - 5 * 60) * 1e3
  return token
}

function getUserObject (user) {
  const result = {
    id: user.id.toString(),
    email: user.email,
    confirmed: user.confirmed === true,
    profile: user.profileFilled === true
  }

  if (user.user_profile?.firstName) result.firstName = user.user_profile.firstName
  if (user.user_profile?.lastName) result.lastName = user.user_profile.lastName

  return result
}

export async function getStrapiFilms (limit, page) {
  const token = await getStrapiToken()
  // set default limit and page values
  limit = limit || 5
  page = page || 1
  // console.log('getStrapiFilms', limit, page)

  const options = {
    headers: { Authorization: `Bearer ${token}` },
    query: {
      _limit: limit,
      _start: (page - 1) * limit
    }
  }
  return await $fetch(`${config.strapiUrl}/films`, options)
}

export async function getStrapiCassettes (limit, page) {
  const token = await getStrapiToken()
  // set default limit and page values
  limit = limit || 5
  page = page || 1
  // console.log('getStrapiCassettes', limit, page)

  const options = {
    headers: { Authorization: `Bearer ${token}` },
    query: {
      _limit: limit,
      _start: (page - 1) * limit
    }
  }
  return await $fetch(`${config.strapiUrl}/cassettes`, options)
}

export async function getStrapiCinemas () {
  const token = await getStrapiToken()
  // console.log('getStrapiCinemas', token)
  return await $fetch(`${config.strapiUrl}/cinemas`, { headers: { Authorization: `Bearer ${token}` } })
}

export async function getStrapiFilm (id) {
  const token = await getStrapiToken()

  return await $fetch(`${config.strapiUrl}/films/${id}`, { headers: { Authorization: `Bearer ${token}` } })
}

export async function getPaymentMethods (id) {
  // eslint-disable-next-line no-console
  console.log('getPaymentMethods')
  const token = await getStrapiToken()
  return await $fetch(`${config.strapiUrl}/users-permissions/users/paymentmethods/${id}`, { headers: { Authorization: `Bearer ${token}` } })
}

export async function buyProduct (body) {
  // eslint-disable-next-line no-console
  console.log('strapi:buyProduct', body)
  const token = await getStrapiToken()

  const result = await $fetch(`${config.strapiUrl}/users-permissions/users/buyproduct/`, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body
  })

  return result
}

export async function roleCheck (body) {
  // console.log('roleCheck', body)
  const token = await getStrapiToken()

  const result = await $fetch(`${config.strapiUrl}/users-permissions/users/rolecheck`, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body
  })

  return result
}
