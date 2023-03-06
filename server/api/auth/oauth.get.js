export default defineEventHandler(async (event) => {
  const method = getMethod(event)
  const headers = getRequestHeaders(event)
  const query = getQuery(event)
  const body = method === 'POST' ? await readBody(event) : undefined

  return { method, headers, query, body }
})
