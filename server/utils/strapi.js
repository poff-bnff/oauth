export async function getStrapiUser (email) {
  const config = useRuntimeConfig()

  const { jwt: token } = await $fetch(`${config.strapiUrl}/auth/local`, {
    method: 'POST',
    body: {
      identifier: config.strapiUser,
      password: config.strapiPassword
    }
  })

  const [user] = await $fetch(`${config.strapiUrl}/users?email=${email}`, { headers: { Authorization: `Bearer ${token}` } })

  if (user) {
    const result = {
      id: user.id,
      email: user.email,
      profile: user.profileFilled
    }

    if (user.user_profile?.firstName) result.firstName = user.user_profile.firstName
    if (user.user_profile?.lastName) result.lastName = user.user_profile.lastName

    return result
  } else {
    const newUser = await $fetch(`${config.strapiUrl}/auth/local/register`, {
      method: 'POST',
      body: {
        email,
        username: email,
        password: Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15)
      }
    })

    console.log('New user created', newUser)
  }
}
