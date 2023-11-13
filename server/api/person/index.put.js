// helpful article: https://www.freecodecamp.org/news/handle-file-uploads-on-the-backend-in-node-js-nuxt/

export default defineEventHandler(async (event) => {
  const body = await readMultipartFormData(event)
  const id = getUserIdFromEvent(event)
  console.log('api::person PUT - user id', id) // eslint-disable-line no-console
  console.log('api::person PUT - body', body.map(({ name, filename, type }) => ({ name, filename, type }))) // eslint-disable-line no-console
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
  const personData = {
    id: user.person.id,
    images: []
  }
  // if body.data is present, it's a stringified JSON object and needs to be parsed
  if (body.data) {
    const data = JSON.parse(body.data.toString())
    Object.keys(data).forEach((key) => {
      body[key] = data[key]
    })
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
    } else {
      personData[name] = data.toString()
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
    const person = await setStrapiPerson(personData)
    returnValue.body = 'Thanks for the all the fish, and the sofa.'
    returnValue.person = person
  } catch (error) {
    throw createError({ statusCode: 500, statusMessage: 'Error setting person' })
  }

  return returnValue
})
