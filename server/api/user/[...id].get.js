export default defineEventHandler(async (event) => {

  const token = getAdminBearer(event)

  const uid = event.context.params.id

  const user = getStrapiUserForFiona(uid, token)

  return user
})