import crypto from 'crypto'
import jwt from 'jsonwebtoken'

const config = useRuntimeConfig()

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

export async function getStrapiUser (id) {
  if (!id) return null

  const token = await getStrapiToken()

  return await $fetch(`${config.strapiUrl}/users/${id}`, { headers: { Authorization: `Bearer ${token}` } })
}

export async function setStrapiUser (user) {
  if (!user) return null

  const token = await getStrapiToken()

  return await $fetch(`${config.strapiUrl}/users/${user.id}`, {
    method: 'PUT',

    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json'
    },

    user
  })
}

export async function setStrapiMyFavorite (user, cassetteId) {
  if (!cassetteId) return null
  if (!user) return null

  const token = await getStrapiToken()
  const myFavorites = (user.my_favorites || [])

  // If the cassette was already in the user's favorites, remove it.
  // Otherwise, add it.
  const index = myFavorites.findIndex(favorite => favorite.id === cassetteId)
  if (index > -1) {
    myFavorites.splice(index, 1)
  } else {
    myFavorites.push({ id: cassetteId })
  }

  // Update user's favorites list
  const result = await $fetch(`${config.strapiUrl}/users/${user.id}`, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: {
      id: user.id,
      // Cleanup cassette objects in favorites list;
      // leave only id properties of each cassette
      my_favorites: myFavorites.map(favorite => ({ id: favorite.id }))
    }
  })

  return result.my_favorites
}

export function getUserIdFromEvent (event) {
  const headers = getRequestHeaders(event)

  const token = headers?.authorization?.split(' ')[1]

  if (!token) throw createError({ statusCode: 401, statusMessage: 'Unauthorized' })

  try {
    const { sub } = jwt.verify(token, config.jwtSecret)

    return sub
  } catch (error) {
    throw createError({ statusCode: 401, statusMessage: 'Invalid token' })
  }
}

async function getStrapiToken () {
  const { jwt: token } = await $fetch(`${config.strapiUrl}/auth/local`, {
    method: 'POST',
    body: {
      identifier: config.strapiUser,
      password: config.strapiPassword
    }
  })

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

export async function getStrapiFilms () {
  const token = await getStrapiToken()

  return await $fetch(`${config.strapiUrl}/cassettes`, { headers: { Authorization: `Bearer ${token}` } })
}

export async function getStrapiFilm (id) {
  const token = await getStrapiToken()

  return await $fetch(`${config.strapiUrl}/films/${id}`, { headers: { Authorization: `Bearer ${token}` } })
}
