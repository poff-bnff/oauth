// helpful article: https://www.freecodecamp.org/news/handle-file-uploads-on-the-backend-in-node-js-nuxt/

export default defineEventHandler(async (event) => {
  const body = await readMultipartFormData(event)
  const id = getUserIdFromEvent(event)
  //console.log('api::person PUT - user id', id) // eslint-disable-line no-console
  //console.log('api::person PUT - body', body) // eslint-disable-line no-console

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

  if (!Array.isArray(user.organisations) || user.organisations.length === 0) {
    throw createError({
      statusCode: 404,
      statusMessage: 'organisation::PUT Organisation not Found'
    })
  }

  const originalOrganisation = await getStrapiOrganisation(user.organisations[0].id)
  const originalOrganisationId = originalOrganisation.id
  // console.log('api::person PUT - user.person', user.person) // eslint-disable-line no-console
  const organisationData = {
    id: originalOrganisationId
  }


  const newFilename = getFileName(body)
  let images = findFieldValue(body, 'images', [])
  const newCollectionIds = {};

  for (let ix = 0; ix < body.length; ix++) {
    const { name, data, filename, type } = body[ix]
    if (name === 'files.profile_img') {
      console.log(`api::organisation PUT - ${name} - ${filename} - ${type}`) // eslint-disable-line no-console
      body[ix].filename = newFilename + filename.substring(filename.lastIndexOf('.'))
      const metadata = findFieldValue(body, 'metadata_profile_img', '{}')
      const savedPic = await uploadStrapiImage(body[ix], 'organisation', originalOrganisationId, JSON.stringify({ caption: metadata }))
      if (savedPic.id) {
        organisationData.profile_img = savedPic.id
      }
    } else if (name === 'files.logoColour') {
      console.log(`api::organisation PUT - ${name} - ${filename} - ${type}`) // eslint-disable-line no-console
      body[ix].filename = `R_${newFilename}` + filename.substring(filename.lastIndexOf('.'))
      const metadata = findFieldValue(body, 'metadata_logoColour', '{}')
      const savedPic = await uploadStrapiImage(body[ix], 'organisation', originalOrganisationId, JSON.stringify({ caption: metadata }))
      if (savedPic.id) {
        organisationData.logoColour = savedPic.id
      }
    } else if (name === 'files.audioreel') {
      console.log(`api::organisation PUT - ${name} - ${filename} - ${type}`) // eslint-disable-line no-console
      body[ix].filename = `${newFilename}` + filename.substring(filename.lastIndexOf('.'))
      const audioreel = await uploadStrapiImage(body[ix], 'organisation', originalOrganisationId)
      if (audioreel.id) {
        organisationData.audioreel = audioreel.id
      }
    } else if (name === 'files.stills') {
      continue
    } else if (name === 'deleted_img_logoColour') {
      organisationData.logoColour = null
    } else if (name === 'deleted_img_profile_img') {
      organisationData.profile_img = null
    } else if (name === 'deleted_audioreel') {
      organisationData.audioreel = null
    } else if (name.startsWith('files.images.new.img.')) {
      console.log(`api::organisation PUT - ${name} - ${filename} - ${type}`) // eslint-disable-line no-console
      body[ix].filename = newFilename + filename.substring(filename.lastIndexOf('.'))
      const sequenceNumber = parseInt(name.match(/\d+$/))
      if (isNaN(sequenceNumber)) {
        continue
      }
      const metadata = findFieldValue(body, `files.images.new.metadata.${sequenceNumber}`, '{}')
      const savedPic = await uploadStrapiImage(body[ix], 'organisation', originalOrganisationId, JSON.stringify({ caption: metadata }))
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
      const originalImages = originalOrganisation.images.map( e => parseInt(e.id))
      if (originalImages.includes(strapiImageId)) {
        await refreshStrapiImageFileInfo(strapiImageId, JSON.stringify({ caption: data }))
      }
    } else if (name == 'orderedRaF') {
      organisationData.orderedRaF = data

      // if data is object with id property, convert to number
      // if data is an array, convert to array of numbers
      // else leave as it is
    } else if (Array.isArray(data)) {
      // console.log(`api::person PUT - is array - ${data}`) // eslint-disable-line no-console
      organisationData[name] = []
      for (let ix = 0; ix < data.length; ix++) {
        const item = data[ix]
        if (typeof item === 'object') {
          const newCollectionId = await setCollection(name, item)
          // console.log('api::person PUT - is array newCollection', newCollectionId) // eslint-disable-line no-console
          organisationData[name].push(newCollectionId)
        } else {
          organisationData[name].push(Number(item))
        }
      }
      // console.log(`api::person PUT - is array - ${organisationData[name]}`) // eslint-disable-line no-console
    } else if (typeof data === 'object') {
      if (name == 'addr_coll') {
        organisationData[name] = await setCollection(name, data)
      }else if (name == 'client') {
        await saveClient(originalOrganisation, data)
      } else if (name == 'filmography') {
        let originalFilmographies = originalOrganisation.filmographies.map(e => parseInt(e.id))
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
          organisationData['filmographies'] = originalFilmographies
        }
      }
    } else {
      organisationData[name] = data
    }
  }

  if (originalOrganisationId !== organisationData.id) {
    console.log('api::organisation PUT - user.organisation.id !== organisationData.id', {
      userOrganisationId: user.organisation.id,
      dataOrganisationId: organisationData.id
    })

    throw createError({
      statusCode: 409,
      userOrganisationId: originalOrganisationId,
      dataOrganisationId: organisationData.id,
      statusMessage: 'organisation::PUT Organisation id does not match user.organisation.id'
    })
  }

  ['logoColour', 'profile_img'].forEach(async (field) => {
    await refreshImagesMetadata(originalOrganisation, organisationData, field)
  })


  organisationData.id = Number(organisationData.id);


  ['employees_n', 'h_rate_from', 'h_rate_to'].forEach(key => {
    organisationData[key] = organisationData[key] == "" ? null : (isNaN(organisationData[key]) ? null : parseInt(organisationData[key]))
  })

  if (organisationData['name_en']) {
    organisationData['namePrivate'] = organisationData['name_en'];
    organisationData['slug_en'] = slugify(organisationData['name_en']);

    ['et', 'ru'].forEach(async (lang) => {
      if (!originalOrganisation[`name_${lang}`] || originalOrganisation[`name_${lang}`] == originalOrganisation[`name_en`])  {
        organisationData[`name_${lang}`] = organisationData['name_en']
        organisationData[`slug_${lang}`] = slugify(organisationData['name_en'])
      }
    })
  }


  const returnValue = {
    organisationId: originalOrganisationId,
    statusCode: 200
  }
  try {
    console.log('api::organisation PUT - sending organisationData', organisationData) // eslint-disable-line no-console
    await setStrapiUser({'id': id, 'ok_to_contact': organisationData['ok_to_contact']})
    let organisation = await setStrapiOrganisation(organisationData)
    organisation = await simplifyOrganisationCollection(organisation, user)
    returnValue.body = 'Thanks for the all the fish, and the sofa.'
    returnValue.newCollectionIds = newCollectionIds
    returnValue.organisation = organisation
  } catch (error) {
    console.log('api::organisation PUT - error', error) // eslint-disable-line no-console
    throw createError({ statusCode: 500, statusMessage: 'Error setting organisation' })
  }

  return returnValue
})

const refreshImagesMetadata = async (originalOrganisation, organisationData, field) => {
  if (typeof organisationData[field] == 'undefined' && typeof organisationData[`deleted_img_${field}`] == 'undefined') {
    const id = originalOrganisation[field]?.id
    if (id) {
      if (originalOrganisation[field]?.caption !== organisationData[`metadata_${field}`]) {
        await refreshStrapiImageFileInfo(id, JSON.stringify({caption: organisationData[`metadata_${field}`]}))
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

  if (entry === undefined) {
    return
  }
  const { name, data, filename, type } = entry

  console.log(`api::filmography still PUT - ${name} - ${filename} - ${type}`) // eslint-disable-line no-console
  const newFilename = slugify(filmography.work_name).substring(0, 100)
  entry.filename = `F_1_${newFilename}` + filename.substring(filename.lastIndexOf('.'))

  const savedPic = await uploadStrapiImage(entry, null, null)
  if (savedPic.id) {
    filmography.stills = [savedPic.id]
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

const getFileName = (body) => {
  const data = body.find(data => data.name == "name_en")
  const orgName = data ? data.data : "missing name"
  return orgName.toLowerCase().substring(0, 100)
}

const slugify = (text) => {
  return text.toString().toLowerCase()
      .replace(/\s+/g, '-')           // Replace spaces with -
      .replace(/[^\w\-]+/g, '')       // Remove all non-word chars
      .replace(/\-\-+/g, '-')         // Replace multiple - with single -
      .replace(/^-+/, '')             // Trim - from start of text
      .replace(/-+$/, '');            // Trim - from end of text
}

const saveClient = async (originalOrganisation, data) => {
  let originalClients = originalOrganisation.clients.map(e => parseInt(e.id))
  if (data.id) {
    if (!originalClients.includes(parseInt(data.id))) {
      return
    }
  }

  const clientOrganisation = await getStrapiOrganisationByField('namePrivate', data.name)
  if (clientOrganisation.id) {
    const clientData = {
      "organisation": originalOrganisation.id,
      "url": data.url ?? null,
      "description": data.description ?? null,
      "client_organisation": clientOrganisation.id
    }
    if (data.id) {
      clientData["id"] = data.id
    }
    const clientId = await setCollection('client', clientData)
    if (data.id != clientId) {
      newCollectionIds['client'] = clientId
    }
  }
}
