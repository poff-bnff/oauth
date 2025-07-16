export default defineEventHandler(async (event) => {
  const userId = getUserIdFromEvent(event)
  const user = await getStrapiUser(userId)
  if (!user) throw createError({ statusCode: 404, statusMessage: 'Not Found' })

  if (!user.organisation || Object.keys(user.organisation).length === 0) {
    user.organisation = await createStrapiOrganisation(user)
  }
  let organisation = await getStrapiOrganisation(user.organisation.id)
  organisation = await simplifyOrganisationCollection(organisation, user)
  return organisation
})
