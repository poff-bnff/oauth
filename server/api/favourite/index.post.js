export default defineEventHandler(async (event) => {
  const headers = getRequestHeaders(event)
  const query = getQuery(event)
  const body = await readBody(event)

  return { headers, query, body }
})
