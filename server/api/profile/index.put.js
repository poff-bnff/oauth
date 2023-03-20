export default defineEventHandler(async (event) => {
  const body = await readBody(event)

  const user = await setStrapiUser(body)
  return user
})
