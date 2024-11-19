// helpful article: https://www.freecodecamp.org/news/handle-file-uploads-on-the-backend-in-node-js-nuxt/

export default defineEventHandler(async (event) => {

  const flatPostData = await getFlatPostData(event)

  const formType = flatPostData.addProType
  console.log(`api::addpro ${formType} PUT - body`, flatPostData) // eslint-disable-line no-console

  validateAllowedFormType(formType)

  const newCollectionIds = {}

  const id = getUserIdFromEvent(event)
  const user = await getStrapiUser(id)

  validateUserIsFound(user)

  const postData = formType == 'organisation' ? await getOrganisationPostData(flatPostData, user, newCollectionIds) : await getPersonPostData(flatPostData, user, newCollectionIds)

  const returnValue = {
    statusCode: 200
  }
  try {
    console.log(`api::addpro ${formType} PUT - sending postData:`, postData) // eslint-disable-line no-console
    if (user['ok_to_contact'] != flatPostData['ok_to_contact']) {
      await setStrapiUser({ 'id': id, 'ok_to_contact': flatPostData['ok_to_contact'] })
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
    console.log(`api::addPro (${formType}) PUT - error ${error}`) // eslint-disable-line no-console
    throw createError({ statusCode: 500, statusMessage: `Error setting ${formType}`})
  }

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
  return flatPostData;
}

function validateAllowedFormType(formType) {
  if (formType !== 'organisation' && formType !== 'person') {
    console.log(`api::addPro validateError not suported type: ${formType}`)
    throw createError({
      statusCode: 409,
      statusMessage: `not suported type: ${formType}`
    })
  }
}

function validateUserIsFound(user) {
  if (!user) {
    console.log(`api::addPro validateError User not found`)
    throw createError({
      statusCode: 404,
      statusMessage: 'person::PUT User not Found'
    })
  }
}

async function getOrganisationPostData(flatPostData, user, newCollectionIds) {
  if (!Array.isArray(user.organisations) || user.organisations.length === 0) {
    console.log(`api::addPro validateError Organisation not found`)
    throw createError({
      statusCode: 404,
      statusMessage: 'addpro::PUT Organisation not Found'
    })
  }

  const originalObject = await getStrapiOrganisation(user.organisations[0].id)
  return await getAddProOrganisationPostData(flatPostData, originalObject, newCollectionIds)
}

async function getPersonPostData(flatPostData, user, newCollectionIds) {
  if (!user.person || Object.keys(user.person).length === 0) {
    console.log(`api::addPro validateError Person not found`)
    throw createError({
      statusCode: 404,
      statusMessage: 'addpro::PUT person not Found'
    })
  }

  const originalObject = await getStrapiPerson(user.person.id)
  return await getAddProPersonPostData(flatPostData, originalObject, newCollectionIds)

}
