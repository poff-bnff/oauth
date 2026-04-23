// helpful article: https://www.freecodecamp.org/news/handle-file-uploads-on-the-backend-in-node-js-nuxt/

import { logOperational } from '~/server/utils/safeLogger'

export default defineEventHandler(async (event) => {
  const route = 'api::addpro PUT'

  const flatPostData = await getFlatPostData(event)

  const formType = flatPostData.addProType

  validateAllowedFormType(formType, event, route)

  const newCollectionIds = {}

  const id = getUserIdFromEvent(event)
  const user = await getStrapiUser(id)

  validateUserIsFound(user, event, route)

  const postData = formType == 'organisation' ? await getOrganisationPostData(flatPostData, user, newCollectionIds) : await getPersonPostData(flatPostData, user, newCollectionIds)

  const returnValue = {
    statusCode: 200
  }
  try {
    if (user['ok_to_contact'] != flatPostData['ok_to_contact']) {
      await setStrapiUser({ 'id': user.id, 'ok_to_contact': flatPostData['ok_to_contact'] })
    }

    if (formType == 'organisation') {
      let organisation = await setStrapiOrganisation(postData)
      organisation = await simplifyOrganisationCollection(organisation, user)
      returnValue.organisation = organisation
    } else {
      let person = await setStrapiPerson(postData)
      person = await simplifyPersonCollection(person, user)
      returnValue.person = person
    }

    returnValue.body = 'Thanks for the all the fish, and the sofa.'
    returnValue.newCollectionIds = newCollectionIds
  } catch (error) {
    logOperational(event, {
      route,
      status: 500,
      errorCode: `ADDPRO_${String(formType || 'UNKNOWN').toUpperCase()}_SET_FAILED`
    })
    throw createError({ statusCode: 500, statusMessage: `Error setting ${formType}` })
  }

  logOperational(event, { route, status: 200 })
  return returnValue
})

async function getFlatPostData(event) {
  const body = await readMultipartFormData(event)

  const bodyData = JSON.parse(
    body.filter(element => (element.name === 'data'))[0].data.toString()
  )

  body.splice(body.findIndex(element => (element.name === 'data')), 1)

  const flatPostData = {}
  Object.keys(bodyData).forEach((key) => {
    flatPostData[key] = bodyData[key]
  })

  for (let ix = 0; ix < body.length; ix++) {
    flatPostData[body[ix].name] = body[ix]
  }
  return flatPostData
}

function validateAllowedFormType(formType, event, route) {
  if (formType !== 'organisation' && formType !== 'person') {
    logOperational(event, { route, status: 409, errorCode: 'ADDPRO_UNSUPPORTED_TYPE' })
    throw createError({
      statusCode: 409,
      statusMessage: `not suported type: ${formType}`
    })
  }
}

function validateUserIsFound(user, event, route) {
  if (!user) {
    logOperational(event, { route, status: 404, errorCode: 'ADDPRO_USER_NOT_FOUND' })
    throw createError({
      statusCode: 404,
      statusMessage: 'person::PUT User not Found'
    })
  }
}

async function getOrganisationPostData(flatPostData, user, newCollectionIds) {
  if (!user.organisation || Object.keys(user.organisation).length === 0) {
    user.organisation = await createStrapiOrganisation(user)
  }

  const originalObject = await getStrapiOrganisation(user.organisation.id)
  return await getAddProOrganisationPostData(flatPostData, originalObject, newCollectionIds)
}

async function getPersonPostData(flatPostData, user, newCollectionIds) {
  if (!user.person || Object.keys(user.person).length === 0) {
    user.person = await createStrapiPerson(user)
  }

  const originalObject = await getStrapiPerson(user.person.id)
  return await getAddProPersonPostData(flatPostData, originalObject, newCollectionIds)
}
