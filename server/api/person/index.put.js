// helpful article: https://www.freecodecamp.org/news/handle-file-uploads-on-the-backend-in-node-js-nuxt/

export default defineEventHandler(async (event) => {
  const body = await readMultipartFormData(event)
  const id = getUserIdFromEvent(event)
  console.log('api::person PUT - user id', id) // eslint-disable-line no-console
  // console.log('api::person PUT - body', body) // eslint-disable-line no-console

  // find the element with name 'data' and parse it
  const bodyData = JSON.parse(
    body.filter(element => (element.name === 'data'))[0].data.toString()
  )
  // console.log('api::person PUT - bodyData', bodyData) // eslint-disable-line no-console
  // remove the element with name 'data'
  await body.splice(body.findIndex(element => (element.name === 'data')), 1)
  // console.log('api::person PUT - body', body) // eslint-disable-line no-console

  // add the parsed bodydata elements to the body
  await Object.keys(bodyData)
    .filter(key => bodyData[key] !== null)
    .filter(key => bodyData[key] !== undefined)
    .forEach((key) => {
      body.push({
        name: key,
        data: bodyData[key]
      })
    })
  console.log('api::person PUT - body', body) // eslint-disable-line no-console

  const user = await getStrapiUser(id)
  if (!user) {
    throw createError({
      statusCode: 404,
      statusMessage: 'person::PUT User not Found'
    })
  }
  if (!user.person || Object.keys(user.person).length === 0) {
    throw createError({
      statusCode: 404,
      statusMessage: 'person::PUT Person not Found'
    })
  }

  // Add all properties sans pictures to personData
  // console.log('api::person PUT - user.person', user.person) // eslint-disable-line no-console
  const personData = {
    id: user.person.id,
    images: []
  }

  for (let ix = 0; ix < body.length; ix++) {
    const { name, data, filename, type } = body[ix]
    if (name === 'files.picture') {
      console.log(`api::person PUT - ${name} - ${filename} - ${type}`) // eslint-disable-line no-console
      const savedPic = await uploadStrapiImage(body[ix], 'person', user.person.id)
      if (savedPic.id) {
        personData.picture = savedPic.id
      }
    } else if (name === 'files.images') {
      console.log(`api::person PUT - ${name} - ${filename} - ${type}`) // eslint-disable-line no-console
      const savedImage = await uploadStrapiImage(body[ix], 'person', user.person.id)
      if (savedImage.id) {
        personData.images.push(savedImage.id)
      }
    // if data is object with id property, convert to number
    // if data is an array, convert to array of numbers
    // else leave as it is
    } else if (Array.isArray(data)) {
      console.log(`api::person PUT - is array - ${data}`) // eslint-disable-line no-console
      personData[name] = []
      for (let ix = 0; ix < data.length; ix++) {
        const item = data[ix]
        if (typeof item === 'object') {
          const newCollectionId = await setCollection(name, item)
          console.log('api::person PUT - is array newCollection', newCollectionId) // eslint-disable-line no-console
          personData[name].push(newCollectionId)
        } else {
          personData[name].push(Number(item))
        }
      }
      console.log(`api::person PUT - is array - ${personData[name]}`) // eslint-disable-line no-console
    } else if (typeof data === 'object') {
      console.log('api::person PUT - is object', data) // eslint-disable-line no-console
      personData[name] = await setCollection(name, data)
    } else {
      personData[name] = data
    }
  }

  personData.id = Number(personData.id)
  if (user.person.id !== personData.id) {
    console.log('api::person PUT - user.person.id', {
      userPersonId: user.person.id,
      dataPersonId: personData.id
    })

    throw createError({
      statusCode: 409,
      userPersonId: user.person.id,
      dataPersonId: personData.id,
      statusMessage: 'person::PUT Person id does not match user.person.id'
    })
  }

  const returnValue = {
    personId: user.person.id,
    statusCode: 200
  }
  try {
    console.log('api::person PUT - sending personData', personData) // eslint-disable-line no-console
    const person = await setStrapiPerson(personData)
    returnValue.body = 'Thanks for the all the fish, and the sofa.'
    returnValue.person = person
  } catch (error) {
    console.log('api::person PUT - error', error) // eslint-disable-line no-console
    throw createError({ statusCode: 500, statusMessage: 'Error setting person' })
  }

  return returnValue
})

const collectionNames = {
  addr_coll: 'addresses',
  filmographies: 'filmographies'
}

// returns id of new collection
const setCollection = async (name, data) => {
  if (data.id) {
    const modifiedCollection = await putStrapiCollection(collectionNames[name], data)
    console.log(`api::person PUT: setCollection with id - ${name}, ${data.id}`, modifiedCollection) // eslint-disable-line no-console
    return Number(data.id)
  } else {
    console.log(`api::person PUT: setCollection without id - ${name}`, data) // eslint-disable-line no-console
    const newCollection = await postStrapiCollection(collectionNames[name], data)
    return Number(newCollection.id)
  }
}
