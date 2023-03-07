export default defineEventHandler(async (event) => {
  const headers = getRequestHeaders(event)
  const query = getQuery(event)

  const redirectCookie = useCookie(event, 'redirect_uri')
  const stateCookie = useCookie(event, 'state')

  return { headers, query, redirectCookie: redirectCookie.value, stateCookie: stateCookie.value }
})
