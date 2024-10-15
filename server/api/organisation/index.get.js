import { createStrapiOrganisation, getStrapiFilmographies } from "~/server/utils/strapi"

export default defineEventHandler(async (event) => {
  const userId = getUserIdFromEvent(event)
  const user = await getStrapiUser(userId)
  if (!user) throw createError({ statusCode: 404, statusMessage: 'Not Found' })

  if (!Array.isArray(user.organisations) || user.organisations.length === 0) {
    user.organisations = await createStrapiOrganisation(user)
  }
  let organisation = await getStrapiOrganisation(user.organisations[0].id)
  organisation = await simplifyOrganisationCollection(organisation, user)
  return organisation
})
