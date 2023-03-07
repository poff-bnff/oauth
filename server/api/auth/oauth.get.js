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
    state: stateCookie.value
  }

  const { data: token } = await useFetch('https://oauth.ee/token', { method: 'POST', body })
  const { data: user } = await useFetch('https://oauth.ee/user', { headers: { Authorization: `Bearer ${token.access_token}` } })

  return { headers, query, redirectCookie: redirectCookie.value, stateCookie: stateCookie.value, user }
})
