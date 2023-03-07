export default defineEventHandler(async (event) => {
  const headers = getRequestHeaders(event)
  const query = getQuery(event)

  const redirectCookie = getCookie(event, 'redirect_uri')
  const stateCookie = getCookie(event, 'state')

  const { oauthClientId, oauthClientSecret } = useRuntimeConfig()

  const body = {
    client_id: oauthClientId,
    client_secret: oauthClientSecret,
    code: query.code,
    grant_type: 'authorization_code',
    state: stateCookie
  }

  const { access_token: token } = await $fetch('https://oauth.ee/token', { method: 'POST', body })
  const user = await $fetch('https://oauth.ee/user', { headers: { Authorization: `Bearer ${token}` } })

  return { headers, query, redirectCookie, stateCookie, user }
})
