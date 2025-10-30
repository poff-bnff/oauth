export default defineEventHandler(async (event) => {

  return "This is an API endpoint that exists for testing purposes only."

  const uid = event.context.params.id

  const user = await getStrapiUser(uid)

  const response = await updateUserAndAliasesRoles(user)

  return response
})