export default defineEventHandler(async (event) => {
  const headers = getRequestHeaders(event)
  const query = getQuery(event)

  return { headers, query }
})
