// helpful article: https://www.freecodecamp.org/news/handle-file-uploads-on-the-backend-in-node-js-nuxt/

export default defineEventHandler(async (event) => {
  const body = await readMultipartFormData(event)

  const bodyData = JSON.parse(
    body.filter(element => (element.name === 'data'))[0].data.toString()
  )

  body.splice(body.findIndex(element => (element.name === 'data')), 1)

  Object.keys(bodyData)
    .forEach((key) => {
      body.push({
        name: key,
        data: bodyData[key]
      })
    })


  const formType = findFieldValue(body, 'addProType', false)
  if (formType !== 'organisation' && formType !== 'person') {
    throw createError({
      statusCode: 409,
      statusMessage: `not suported type: ${formType}`
    })
  }

  console.log(`api::addpro ${formType} PUT - body`, body) // eslint-disable-line no-console
  let postData = {}

  const id = getUserIdFromEvent(event)
  const user = await getStrapiUser(id)
  if (!user) {
    throw createError({
      statusCode: 404,
      statusMessage: 'person::PUT User not Found'
    })
  }
  var originalObjectId;
  var originalObject
  if (formType == 'organisation') {
    if (!Array.isArray(user.organisations) || user.organisations.length === 0) {
      throw createError({
        statusCode: 404,
        statusMessage: 'addpro::PUT Organisation not Found'
      })
    }

    originalObject = await getStrapiOrganisation(user.organisations[0].id)
    originalObjectId = originalObject.id
    // console.log('api::person PUT - user.person', user.person) // eslint-disable-line no-console
    postData = {
      id: originalObjectId
    }
  } else {
    if (!user.person || Object.keys(user.person).length === 0) {
      throw createError({
        statusCode: 404,
        statusMessage: 'addpro::PUT person not Found'
      })
    }

    originalObject = await getStrapiPerson(user.person.id)
    originalObjectId = originalObject.id
    postData = {
      id: originalObjectId
    }
  }

  const newFilename = getFileName(body, formType)
  let images = findFieldValue(body, 'images', [])
  const newCollectionIds = {};

  for (let ix = 0; ix < body.length; ix++) {
    const { name, data, filename, type } = body[ix]
    if (name === 'files.profile_img') {
      console.log(`api::organisation PUT - ${name} - ${filename} - ${type}`) // eslint-disable-line no-console
      let imgPrefix = ''
      if (formType == 'person') {
        imgPrefix = 'R_'
      }
      body[ix].filename = imgPrefix + newFilename + filename.substring(filename.lastIndexOf('.'))
      const metadata = findFieldValue(body, 'metadata_profile_img', '{}')
      const savedPic = await uploadStrapiImage(body[ix], 'organisation', originalObjectId, JSON.stringify({ caption: metadata }))
      if (savedPic.id) {
        postData.profile_img = savedPic.id
      }
    } else if (name === 'files.logoColour') {
      console.log(`api::organisation PUT - ${name} - ${filename} - ${type}`) // eslint-disable-line no-console
      body[ix].filename = `R_${newFilename}` + filename.substring(filename.lastIndexOf('.'))
      const metadata = findFieldValue(body, 'metadata_logoColour', '{}')
      const savedPic = await uploadStrapiImage(body[ix], 'organisation', originalObjectId, JSON.stringify({ caption: metadata }))
      if (savedPic.id) {
        postData.logoColour = savedPic.id
      }
    } else if (name === 'files.audioreel') {
      console.log(`api::organisation PUT - ${name} - ${filename} - ${type}`) // eslint-disable-line no-console
      body[ix].filename = `${newFilename}` + filename.substring(filename.lastIndexOf('.'))
      const audioreel = await uploadStrapiImage(body[ix], 'organisation', originalObjectId)
      if (audioreel.id) {
        postData.audioreel = audioreel.id
      }
    } else if (name === 'files.stills') {
      continue
    } else if (name === 'deleted_img_logoColour') {
      postData.logoColour = null
    } else if (name === 'deleted_img_profile_img') {
      postData.profile_img = null
    } else if (name === 'deleted_audioreel') {
      postData.audioreel = null
    } else if (name.startsWith('files.images.new.img.')) {
      console.log(`api::organisation PUT - ${name} - ${filename} - ${type}`) // eslint-disable-line no-console
      body[ix].filename = newFilename + filename.substring(filename.lastIndexOf('.'))
      const sequenceNumber = parseInt(name.match(/\d+$/))
      if (isNaN(sequenceNumber)) {
        continue
      }
      const metadata = findFieldValue(body, `files.images.new.metadata.${sequenceNumber}`, '{}')
      const savedPic = await uploadStrapiImage(body[ix], 'organisation', originalObjectId, JSON.stringify({ caption: metadata }))
      if (savedPic.id) {
        const index = images.indexOf(`|${sequenceNumber}|`)
        if (index !== -1) {
          images[index] = savedPic.id;
        }
      }
    } else if (name.startsWith('files.images.changed.metadata.')) {
      const strapiImageId = parseInt(name.match(/\d+$/))
      if (isNaN(strapiImageId)) {
        continue
      }
      const originalImages = originalObject.images.map( e => parseInt(e.id))
      if (originalImages.includes(strapiImageId)) {
        await refreshStrapiImageFileInfo(strapiImageId, JSON.stringify({ caption: data }))
      }
    } else if (name == 'orderedRaF') {
      postData.orderedRaF = data

      // if data is object with id property, convert to number
      // if data is an array, convert to array of numbers
      // else leave as it is
    } else if (Array.isArray(data)) {
      // console.log(`api::person PUT - is array - ${data}`) // eslint-disable-line no-console
      postData[name] = []
      for (let ix = 0; ix < data.length; ix++) {
        const item = data[ix]
        if (typeof item === 'object') {
          const newCollectionId = await setCollection(name, item)
          // console.log('api::person PUT - is array newCollection', newCollectionId) // eslint-disable-line no-console
          postData[name].push(newCollectionId)
        } else {
          postData[name].push(Number(item))
        }
      }
      // console.log(`api::person PUT - is array - ${postData[name]}`) // eslint-disable-line no-console
    } else if (typeof data === 'object' && data !== null) {
      if (name == 'addr_coll') {
        postData[name] = await setCollection(name, data)
      }else if (name == 'client') {
        newCollectionIds['client'] = await saveClient(originalObject, data)
      } else if (name == 'filmography') {
        let originalFilmographies = originalObject.filmographies.map(e => parseInt(e.id))
        if (data.id) {
          if (!originalFilmographies.includes(parseInt(data.id))) {
            continue
          }
        }
        await updateFilmographyStillImages(data, body)

        const id = await setCollection('filmography', data)
        if (!data.id) {
          newCollectionIds['filmography'] = id
          originalFilmographies.push(id)
          postData['filmographies'] = originalFilmographies
        }
      }
    } else {
      postData[name] = data
    }
  }

  if (originalObjectId !== postData.id) {
    console.log('api::organisation PUT - user.organisation.id !== postData.id', {
      userOrganisationId: user.organisation.id,
      dataOrganisationId: postData.id
    })

    throw createError({
      statusCode: 409,
      userOrganisationId: originalObjectId,
      dataOrganisationId: postData.id,
      statusMessage: 'organisation::PUT Organisation id does not match user.organisation.id'
    })
  }

  ['logoColour', 'profile_img'].forEach(async (field) => {
    await refreshImagesMetadata(originalObject, postData, field)
  })


  postData.id = Number(postData.id);
  if (formType == 'organisation') {
    if (postData['name_en']) {
      postData['namePrivate'] = postData['name_en'];
      postData['slug_en'] = slugify(postData['name_en']);

      ['et', 'ru'].forEach(async (lang) => {
        if (!originalObject[`name_${lang}`] || originalObject[`name_${lang}`] == originalObject[`name_en`]) {
          postData[`name_${lang}`] = postData['name_en']
          postData[`slug_${lang}`] = slugify(postData['name_en'])
        }
      })
    }
  }

  if (formType == 'person') {
    if (postData['firstName'] && postData['lastName']) {
      const slug = slugify(`${postData['firstName']}-${postData['lastName']}`);
      postData['slug_en'] = slug
      postData['slug_et'] = slug
      postData['slug_ru'] = slug
    }
  }


  const returnValue = {
    organisationId: originalObjectId,
    statusCode: 200
  }
  try {
    console.log(`api::addpro ${formType} PUT - sending postData:`, postData) // eslint-disable-line no-console
    await setStrapiUser({'id': id, 'ok_to_contact': postData['ok_to_contact']})

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

const refreshImagesMetadata = async (originalObject, postData, field) => {
  if (typeof postData[field] == 'undefined' && typeof postData[`deleted_img_${field}`] == 'undefined') {
    const id = originalObject[field]?.id
    if (id) {
      if (originalObject[field]?.caption !== postData[`metadata_${field}`]) {
        await refreshStrapiImageFileInfo(id, JSON.stringify({caption: postData[`metadata_${field}`]}))
      }
    }
  }
}

const collectionNames = {
  addr_coll: 'addresses',
  filmographies: 'filmographies',
  filmography: 'filmographies',
  client: "clients"
}

const updateFilmographyStillImages = async (filmography, body) => {
  const entry = body.find(data => data.name == 'files.stills')

  if (entry !== undefined) {
    console.log('ADD STILL')
    const { name, data, filename, type } = entry

    console.log(`api::filmography still PUT - ${name} - ${filename} - ${type}`) // eslint-disable-line no-console
    const newFilename = slugify(filmography.work_name).substring(0, 100)
    entry.filename = `F_1_${newFilename}` + filename.substring(filename.lastIndexOf('.'))

    const savedPic = await uploadStrapiImage(entry, null, null)
    if (savedPic.id) {
      filmography.stills = [savedPic.id]
    }
  }
  if (filmography.deleted_img_stills === true) {
    filmography.stills = null
  }
}


// returns id of new collection
const setCollection = async (name, data) => {
  if (data.id) {
    const modifiedCollection = await putStrapiCollection(collectionNames[name], data)
    return Number(modifiedCollection.id)
  } else {
    const newCollection = await postStrapiCollection(collectionNames[name], data)
    return Number(newCollection.id)
  }
}

const findFieldValue = (body, field, placeholder) => {
  for (let ix = 0; ix < body.length; ix++) {
    const { name, data} = body[ix]
    if (name == field) {
      if (typeof data === 'object') {
        return data
      }
      return String(data)
    }
  }
  return
}

const getFileName = (body, type) => {
  let fileName = ""
  if (type == 'organisation') {
    const data = body.find(data => data.name == "name_en")
    fileName = data ? data.data : "missing name"
  } else if (type == "person") {
    const firstName = body.find(data => data.name == "firstName")
    const lastName = body.find(data => data.name == "lastName")
    fileName = slugify(`${firstName.data}-${lastName.data}`)
  }
  return fileName.toLowerCase().substring(0, 100)
}

const slugify = (text) => {
  return text.toString().toLowerCase()
      .replace(/\s+/g, '-')           // Replace spaces with -
      .replace(/[^\w\-]+/g, '')       // Remove all non-word chars
      .replace(/\-\-+/g, '-')         // Replace multiple - with single -
      .replace(/^-+/, '')             // Trim - from start of text
      .replace(/-+$/, '');            // Trim - from end of text
}

const saveClient = async (originalObject, data) => {
  let originalClients = originalObject.clients.map(e => parseInt(e.id))
  if (data.id) {
    if (!originalClients.includes(parseInt(data.id))) {
      return null;
    }
  }

  const clientOrganisation = await getStrapiOrganisationByField('name_en', data.name)
  if (clientOrganisation.id) {
    const clientData = {
      "organisation": originalObject.id,
      "url": data.url ?? null,
      "description": data.description ?? null,
      "client_organisation": clientOrganisation.id
    }
    if (data.id) {
      clientData["id"] = data.id
    }
    const clientId = await setCollection('client', clientData)
    if (data.id != clientId) {
      return clientId
    }
    return null;
  }
}
