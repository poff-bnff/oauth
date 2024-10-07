import { createStrapiOrganisation, getStrapiFilmographies } from "~/server/utils/strapi"

export default defineEventHandler(async (event) => {
  const userId = getUserIdFromEvent(event)
  const user = await getStrapiUser(userId)
  if (!user) throw createError({ statusCode: 404, statusMessage: 'Not Found' })

  if (!Array.isArray(user.organisations) || user.organisations.length === 0) {
    user.organisations = await createStrapiOrganisation(user)
  }
  let organisation = await getStrapiOrganisation(user.organisations[0].id)

  //otherwise we won't see the values ​​of the filmographies subcollections
  if (organisation.filmographies.length) {
    const filmographiesIds = organisation.filmographies.map(function (element) {
      return element.id;
    });
    organisation.filmographies = await getStrapiFilmographies(filmographiesIds)
  }

  organisation.ok_to_contact = user.ok_to_contact  ? 1 : 0
  return organisation
})
