const FESTIVAL_EDITION_CREATIVE_GATE_ID = 59;

export async function getAddProOrganisationPostData(body, originalData, newCollectionIds) {

    const cleanedPostData = {
        id: parseInt(body.id),
    }

    if (body.filmography) {
        saveFilmography(originalData, body.filmography, body, newCollectionIds, 'organisation')
        return cleanedPostData;
    }

    if (body.client) {
        newCollectionIds['client'] = await saveClient(originalData, body.client)
        return cleanedPostData;
    }

    if (body.filmographies) {
        cleanedPostData['filmographies'] = body.filmographies;
        return cleanedPostData;
    }

    if (body.clients) {
        cleanedPostData['clients'] = body.clients;
        return cleanedPostData;
    }


    originalData = await simplifyOrganisationCollection(originalData, null, false)
    const newFileName = body.name_en.substring(0, 100)

    addTextField('name_en', body, originalData, cleanedPostData)

    addObjectArrayField('orderedRaF', body, originalData, cleanedPostData)

    addIntArrayField('people', body, originalData, cleanedPostData)
    addIntField('employees_n', body, originalData, cleanedPostData)

    addIntField('h_rate_from', body, originalData, cleanedPostData)
    addIntField('h_rate_to', body, originalData, cleanedPostData)

    addIntArrayField('languages', body, originalData, cleanedPostData)

    await addFile('profile_img', body, originalData, cleanedPostData, '', true, newFileName, 'organisation')
    await addFile('logoColour', body, originalData, cleanedPostData, 'R_', true, newFileName, 'organisation')

    addTextField('skills_en', body, originalData, cleanedPostData)
    addTextField('description_en', body, originalData, cleanedPostData)

    addIntArrayField('tag_looking_fors', body, originalData, cleanedPostData)

    addTextField('webpage_url', body, originalData, cleanedPostData);
    addTextField('acc_imdb', body, originalData, cleanedPostData);
    addTextField('acc_efis', body, originalData, cleanedPostData);
    addTextField('acc_instagram', body, originalData, cleanedPostData);
    addTextField('acc_fb', body, originalData, cleanedPostData);
    addTextField('acc_youtube', body, originalData, cleanedPostData);
    addTextField('acc_vimeo', body, originalData, cleanedPostData);
    addTextField('acc_other', body, originalData, cleanedPostData);

    addTextField('phoneNr', body, originalData, cleanedPostData);
    addTextField('eMail', body, originalData, cleanedPostData);


    await addAddrColl('addr_coll', body, originalData, cleanedPostData);

    addTextField('showreel', body, originalData, cleanedPostData);

    addFile('audioreel', body, originalData, cleanedPostData, '', false, newFileName, 'organisation');

    await addGallery(body, originalData, cleanedPostData, newFileName, 'organisation')

    await addPrivateFields(body, originalData, cleanedPostData)

    return cleanedPostData;
}

export async function getAddProPersonPostData(body, originalData, newCollectionIds) {
    const cleanedPostData = {
        id: parseInt(body.id),
    }

    if (body.filmography) {
        saveFilmography(originalData, body.filmography, body, newCollectionIds, 'person')
        return cleanedPostData;
    }


    if (body.filmographies) {
        cleanedPostData['filmographies'] = body.filmographies;
        return cleanedPostData;
    }

    originalData = await simplifyPersonCollection(originalData, null, false)
    const newFileName = (body.firstName + ' ' + body.lastName).substring(0, 100)

    addTextField('firstName', body, originalData, cleanedPostData)
    addTextField('lastName', body, originalData, cleanedPostData)

    addObjectArrayField('orderedRaF', body, originalData, cleanedPostData)

    addIntField('h_rate_from', body, originalData, cleanedPostData)
    addIntField('h_rate_to', body, originalData, cleanedPostData)

    addIntField('gender', body, originalData, cleanedPostData)

    addIntField('native_lang', body, originalData, cleanedPostData)
    addIntArrayField('other_lang', body, originalData, cleanedPostData)

    await addFile('profile_img', body, originalData, cleanedPostData, 'R_', true, newFileName, 'person')

    addTextField('skills_en', body, originalData, cleanedPostData)
    addTextField('bio_en', body, originalData, cleanedPostData)

    addIntArrayField('tag_looking_fors', body, originalData, cleanedPostData)

    addTextField('webpage_url', body, originalData, cleanedPostData);
    addTextField('acc_imdb', body, originalData, cleanedPostData);
    addTextField('acc_efis', body, originalData, cleanedPostData);
    addTextField('acc_instagram', body, originalData, cleanedPostData);
    addTextField('acc_fb', body, originalData, cleanedPostData);
    addTextField('acc_youtube', body, originalData, cleanedPostData);
    addTextField('acc_vimeo', body, originalData, cleanedPostData);
    addTextField('acc_etalenta', body, originalData, cleanedPostData);
    addTextField('acc_castupload', body, originalData, cleanedPostData);
    addTextField('acc_other', body, originalData, cleanedPostData);

    addIntField('acting_age_from', body, originalData, cleanedPostData)
    addIntField('acting_age_to', body, originalData, cleanedPostData)
    addIntField('weight_kg', body, originalData, cleanedPostData)
    addIntField('height_cm', body, originalData, cleanedPostData)
    addIntField('eye_colour', body, originalData, cleanedPostData)
    addIntField('hair_colour', body, originalData, cleanedPostData)
    addIntField('hair_length', body, originalData, cleanedPostData)
    addIntField('pitch_of_voice', body, originalData, cleanedPostData)
    addIntField('stature', body, originalData, cleanedPostData)

    addTextField('phoneNr', body, originalData, cleanedPostData);
    addTextField('eMail', body, originalData, cleanedPostData);

    await addAddrColl('addr_coll', body, originalData, cleanedPostData);

    addTextField('showreel', body, originalData, cleanedPostData);

    addFile('audioreel', body, originalData, cleanedPostData, '', false, newFileName, 'person');

    await addGallery(body, originalData, cleanedPostData, newFileName, 'person')

    await addPersonPrivateFields(body, originalData, cleanedPostData)

    addFestivalEdition(originalData, cleanedPostData)

    cleanedPostData.public = 1

    return cleanedPostData;
}

function addFestivalEdition(originalData, cleanedPostData) {
    cleanedPostData.festival_editions = originalData.festival_editions;
    if (!cleanedPostData.festival_editions.includes(FESTIVAL_EDITION_CREATIVE_GATE_ID)) {
        cleanedPostData.festival_editions.push(FESTIVAL_EDITION_CREATIVE_GATE_ID)
    }
}

async function saveClient (originalObject, data) {
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
      const clientId = await setCollection('clients', clientData)
      if (data.id != clientId) {
        return clientId
      }
      return null;
    }
}

async function setCollection(name, data) {
    let collection = {}
    if (data.id) {
      collection = await putStrapiCollection(name, data)
    } else {
      collection = await postStrapiCollection(name, data)
    }
    return Number(collection.id)
}

async function saveFilmography(originalObject, filmography, body, newCollectionIds, objType) {
    let originalFilmographies = originalObject.filmographies.map(e => parseInt(e.id))
    if (filmography.id) {
        if (!originalFilmographies.includes(parseInt(filmography.id))) {
            return
        }
    } else {
        filmography[objType] = originalObject.id
    }

    await updateFilmographyStillImages(filmography, body)
    const id = await setCollection('filmographies', filmography)
    if (!filmography.id) {
        newCollectionIds['filmography'] = Number(id)
    }
}

async function updateFilmographyStillImages (filmography, body)  {
    const entry = body["files.stills"]
    if (entry !== undefined) {
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


function addTextField(field, body, originalData, cleanedPostData) {
    if (body[field] === "" || body[field] === undefined) {
        body[field] = null;
    }

    if (body[field] !== null) {
        body[field] = String(body[field])
    }

    if (body[field] !== originalData[field]) {
        cleanedPostData[field] = body[field]
    }
}


function addIntField(field, body, originalData, cleanedPostData) {
    if (body[field] === "" || body[field] === undefined) {
        body[field] = null;
    }

    if (body[field] !== originalData[field]) {
        let val = parseInt(body[field])
        if (isNaN(val)) {
            val = null
        }
        cleanedPostData[field] = val
    }
}

function addIntArrayField(field, body, originalData, cleanedPostData) {
    if (!Array.isArray(body[field])) {
        body[field] = [];
    }

    if (body[field].toString() !== originalData[field].toString()) {
        cleanedPostData[field] = body[field].map(el => parseInt(el))
    }
}

function addObjectArrayField(field, body, originalData, cleanedPostData) {
    if (!Array.isArray(body[field])) {
        body[field] = [];
    }

    cleanedPostData[field] = body[field]
}

async function addFile(field, body, originalData, cleanedPostData, prefix, sendMetadata = true, newFileName, objType) {
    if (body[`files.${field}`]) {
        const { name, data, filename, type } = body[`files.${field}`]

        body[`files.${field}`]['filename'] = prefix + newFileName + filename.substring(filename.lastIndexOf('.'))

        let metadata = body[`metadata_${field}`]
        if (metadata === undefined && sendMetadata) {
            metadata = {}
        }
        const savedPic = await uploadStrapiImage(body[`files.${field}`], objType, originalData.id, JSON.stringify({ caption: metadata }))
        if (savedPic.id) {
            cleanedPostData[field] = savedPic.id
        }
    } else if (body[`deleted_${field}`]) {
        cleanedPostData[field] = null
    } else if (body[`metadata_${field}`]) {
        const id = originalData[field]?.id
        if (sendMetadata && id) {
            if (originalData[field]?.caption !== body[`metadata_${field}`]) {
                await refreshStrapiImageFileInfo(id, JSON.stringify({caption: body[`metadata_${field}`]}))
            }
        }
    }
}


async function addAddrColl(field, body, originalData, cleanedPostData) {
    const addr_coll = {}

    let existing_addr = originalData.addr_coll

    let isNew = false;
    if (existing_addr === null) {
        existing_addr = {};
        isNew = true;
    }

    const new_addr = body.addr_coll

    addIntField('country', new_addr, existing_addr, addr_coll);
    addIntField('county', new_addr, existing_addr, addr_coll);
    addIntField('municipality', new_addr, existing_addr, addr_coll);

    addTextField('add_county', new_addr, existing_addr, addr_coll);
    addTextField('add_municipality', new_addr, existing_addr, addr_coll);
    addTextField('popul_place', new_addr, existing_addr, addr_coll);
    addTextField('street_name', new_addr, existing_addr, addr_coll);
    addTextField('appartment', new_addr, existing_addr, addr_coll);
    addTextField('postal_code', new_addr, existing_addr, addr_coll);
    addTextField('address_number', new_addr, existing_addr, addr_coll);

    const isEmpty = Object.values(addr_coll).every(x => x === null);

    if (isNew) {
        if (isEmpty) {
            return
        }
        const newCollection = await postStrapiCollection('addresses', addr_coll)
        cleanedPostData['addr_coll'] = Number(newCollection.id)
    } else {
        addr_coll.id = existing_addr.id
        await putStrapiCollection('addresses', addr_coll)
    }
}

async function addGallery(body, originalData, cleanedPostData, newFileName, objType)
{
    const newGalleryImages = Object.keys(body).filter(function (k) {
        return k.indexOf('files.images.new.img.') == 0;
    });
    let images = body.images

    if (images === undefined) {
        images = []
    }

    for await (const field of newGalleryImages ) {
        const sequenceNumber = parseInt(field.match(/\d+$/))
        if (isNaN(sequenceNumber)) {
            continue
        }

        let metadata = body[`files.images.new.metadata.${sequenceNumber}`]
        if (metadata === undefined) {
            metadata = {}
        }
        const { name, data, filename, type } = body[field]

        body[field]['filename'] = newFileName + filename.substring(filename.lastIndexOf('.'))

        const savedPic = await uploadStrapiImage(body[field], objType, originalData.id, JSON.stringify({ caption: metadata }))
        if (savedPic.id) {
            const index = images.indexOf(`|${sequenceNumber}|`)
            if (index !== -1) {
                images[index] = savedPic.id;
            }
        }
    }

    const changedMetaData = Object.keys(body).filter(function (k) {
        return k.indexOf('files.images.changed.metadata.') == 0;
    });

    const originalImages = originalData.images.map( e => parseInt(e.id))
    for await (const field of changedMetaData) {
        const strapiImageId = parseInt(field.match(/\d+$/))
        if (isNaN(strapiImageId)) {
            continue
        }
        if (originalImages.includes(strapiImageId)) {
          await refreshStrapiImageFileInfo(strapiImageId, JSON.stringify({ caption: body[field] }))
        }
    }
    cleanedPostData['images'] = images.map(e => parseInt(e))
}

async function addPrivateFields(body, originalData, cleanedPostData) {
    if (body['name_en'] && (body['name_en'] != originalData[`name_en`] || originalData['slug_en'])) {
        cleanedPostData['namePrivate'] = body['name_en'];
        const slug = slugify(body['name_en']);
        cleanedPostData['slug_en'] = await getUniqSlug(slug, 'application::organisation.organisation', `slug_en`);

        for await (const lang of ['et', 'ru']) {
          if (!originalData[`name_${lang}`] || originalData[`name_${lang}`] == originalData[`name_en`]) {
            cleanedPostData[`name_${lang}`] = body['name_en']
            cleanedPostData[`slug_${lang}`] = await getUniqSlug(slug, 'application::organisation.organisation', `slug_${lang}`)
          }
        }
    }
}

async function addPersonPrivateFields(body, originalData, cleanedPostData) {
    if (body['firstName'] && body['lastName'] && (!originalData['slug_en'] || originalData['firstName'] != body['firstName'] || originalData['lastName'] != body['lastName'])) {
        cleanedPostData['firstNameLastName'] = `${body['firstName']} ${body['lastName']}`
        const slug = slugify(`${body['firstName']}-${body['lastName']}`);
        for await (const lang of ['et', 'en', 'ru'] ) {
          const uniqSlug = await getUniqSlug(slug, 'application::person.person', `slug_${lang}`)
          cleanedPostData[`slug_${lang}`] = uniqSlug
        }
      }
}

function slugify(text) {
    return text.toString().toLowerCase()
      .replace(/\s+/g, '-')           // Replace spaces with -
      .replace(/[^\w\-]+/g, '')       // Remove all non-word chars
      .replace(/\-\-+/g, '-')         // Replace multiple - with single -
      .replace(/^-+/, '')             // Trim - from start of text
      .replace(/-+$/, '');            // Trim - from end of text
}
