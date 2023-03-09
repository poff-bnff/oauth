import crypto from 'crypto'

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

export function getUserIdFromHeader (event) {
  const headers = getRequestHeaders(event)

  console.log(headers)

  const token = headers?.authorization?.split(' ')[1]

  if (!token) return null

  try {
    const { sub } = jwt.verify(token, config.jwtSecret)

    return sub
  } catch (error) {
    return null
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
