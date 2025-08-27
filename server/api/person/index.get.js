export default defineEventHandler(async (event) => {
  const userId = getUserIdFromEvent(event)
  const user = await getStrapiUser(userId)
  if (!user) throw createError({ statusCode: 404, statusMessage: 'Not Found' })

  if (!user.person || Object.keys(user.person).length === 0) {
    return {'type': 'new'}
  }

  let person = await getStrapiPerson(user.person.id)
  person = simplifyPersonCollection(person, user)
  return person
})
