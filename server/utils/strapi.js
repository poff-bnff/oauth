import { URLSearchParams } from 'url'
import crypto from 'crypto'
import jwt from 'jsonwebtoken'


const config = useRuntimeConfig()

const FESTIVAL_EDITION_CREATIVE_GATE_ID = 59;


const STRAPI_TOKEN = {
  token: null,
  expires: null
}

const STRAPI_ADMIN_TOKEN = {
  token: null,
  expires: null
}

export async function authenticateStrapiUser (email) {
  if (!email) return null

  const token = await getStrapiToken()

  const [user] = await $fetch(`${config.strapiUrl}/users?email=${email}`, { headers: { Authorization: `Bearer ${token}` } })

  if (user) {
    return getUserObject(user)
  } else {
    const { user: newUser } = await $fetch(`${config.strapiUrl}/auth/local/register`, {
      method: 'POST',
      body: {
        email,
        username: email,
        password: crypto.randomBytes(32).toString('hex')
      }
    })

    return getUserObject(newUser)
  }
}

export async function emailInUse (email) {
  if (!email) return false

  const token = await getStrapiToken()

  const [profile] = await $fetch(`${config.strapiUrl}/user-profiles?email=${email}`, { headers: { Authorization: `Bearer ${token}` } })

  if (profile) {
    return true
  }

  return false
}

export async function fetchEventivalBadges (email) {
  if (!email) return []

  const edition = config.public.eventivalEdition
  const token = config.eventivalApiToken
  const options = {
    headers: {
      'x-api-key': token
    },
    method: 'GET'
  }

  const eUser = await $fetch(`https://bo.eventival.com/poff/${edition}/api/people?account_email=${email}`, options)

  if (!eUser) {
    // console.log('getEventivalBadges eUser is null', email, eUser)
    return []
  }
  if (!Array.isArray(eUser)) {
    // console.log('getEventivalBadges eUser is not array', email, eUser)
    return []
  }
  if (eUser.length === 0) {
    // console.log('getEventivalBadges eUser is empty array', email, eUser)
    return []
  }
  const badges = eUser[0].badges || []
  return badges
    .filter(badge => !badge.cancelled)
    .map(badge => ({
      type: badge.type,
      barcode: badge.barcode,
      validity_dates: badge.validity_dates
    }))
}

export async function loadEventivalBadges (user) {
  const mainUserEmail = user.email
  const aliasUserEmails = user.aliasUsers.map(user => user.email)
  const emails = [mainUserEmail, ...aliasUserEmails]
  user.badges = []
  for (const email of emails) {
    const evBadges = await fetchEventivalBadges(email)
    user.badges = [...user.badges, ...evBadges]
  }
}

export async function readCourseEventVideolevelsUrl (courseEventId) {
  const token = await getStrapiToken()
  const strapiApiUrl = `${config.strapiUrl}/course-events/${courseEventId}`
  const courseEvent = await $fetch(
    strapiApiUrl,
    { headers: { Authorization: `Bearer ${token}` } })
  return courseEvent.video_url
}

export async function getStrapiUserForFiona (id, token) {
  if (!id) {
    throw createError({ statusCode: 404, statusMessage: 'No user ID provided' })
  }

  const user = await $fetch(`${config.strapiUrl}/users/${id}`, {
    headers: { Authorization: `Bearer ${token}` }
  })
  if (!user) {
    throw createError({ statusCode: 404, statusMessage: `No user with ID ${id}` })
  }

  if (user.mainUser) {
    return getStrapiUserForFiona(user.mainUser.id, token)
  }

  if (user.user_profile === null) {
    // create profile
    // eslint-disable-next-line no-console
    console.log('api::getStrapiUser - creating profile for user', id)
    user.user_profile = await createStrapiUserProfile(user)
  }

  const data = {
    id: user.id,
    emailAddress: user.user_profile.email.indexOf("@eesti.ee") == -1 ? user.user_profile.email : null,
    lastname: user.user_profile.lastName,
    firstname: user.user_profile.firstName
  }

  return data
}

export async function getStrapiUser (id) {
  if (!id) {
    throw createError({ statusCode: 404, statusMessage: 'No user ID provided' })
  }
  const token = await getStrapiToken()

  const user = await $fetch(`${config.strapiUrl}/users/${id}`, {
    headers: { Authorization: `Bearer ${token}` }
  })
  if (!user) {
    throw createError({ statusCode: 404, statusMessage: `No user with ID ${id}` })
  }

  if (user.mainUser && user.aliasUsers && user.aliasUsers.length > 0) {
    const msg = `strapi::getStrapiUser - User ${user.id} has both mainUser ${user.mainUser.id} and aliasUsers ${user.aliasUsers.map(u => u.id)}`
    console.error(msg) // eslint-disable-line no-console
    throw createError({ statusCode: 409, statusMessage: msg })
  }

  if (user.mainUser) {
    return getStrapiUser(user.mainUser.id)
  }

  if (user.user_profile === null) {
    // create profile
    // eslint-disable-next-line no-console
    console.log('api::getStrapiUser - creating profile for user', id)
    user.user_profile = await createStrapiUserProfile(user)
  }

  // remove properties with null values from profile
  Object.keys(user.user_profile).forEach(key => user.user_profile[key] === null && delete user.user_profile[key])
  Object.keys(user).forEach(key => user[key] === null && delete user[key])

  // TODO: will become obsolete, when we finish with move to My
  await mergeUserMy(user)

  return user
}

export async function setStrapiUser (user) {
  if (!user) return null
  const token = await getStrapiToken()
  const id = user.id
  // user.id = id
  // console.log(`setStrapiUser, id: ${id}`)
  return await $fetch(`${config.strapiUrl}/users/${id}`, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: user
  })
}

export async function deleteStrapiUserProfile (id) {
  if (!id) return null
  const token = await getStrapiAdminToken()
  return await $fetch(`${config.strapiUrl}/user-profiles/${id}`, {
    method: 'DELETE',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
  })
}

export async function createStrapiUserProfile (user) {
  if (!user) return null
  const token = await getStrapiToken()
  const userProfile = {
    user: user.id,
    email: user.email
  }
  // eslint-disable-next-line no-console
  console.log('createStrapiUserProfile', userProfile)

  return await $fetch(`${config.strapiUrl}/user-profiles`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: userProfile
  })
}

export async function setStrapiUserProfile (profileId, body) {
  if (!profileId) return new Error('No profile ID provided. Endpoint: "/user-profiles/:id"')
  if (!body) return null
  body.id = profileId
  const token = await getStrapiToken()

  return await $fetch(`${config.strapiUrl}/user-profiles/${profileId}`, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body
  })
}

export async function uploadStrapiImage (file, ref, refId, fileInfo) {
  if (!file) return null

  const token = await getStrapiToken()
  const formData = new FormData()

  const { name, filename, data: databuff } = file
  const blob = new Blob([databuff])

  formData.append('files', blob, filename)
  formData.append('ref', ref)
  formData.append('refId', refId)
  formData.append('field', name)
  if (typeof fileInfo !== 'undefined') {
    formData.append('fileInfo', fileInfo)
  }

  try {
    console.log('uploadStrapiImage') // eslint-disable-line no-console
    const pics = await $fetch(`${config.strapiUrl}/upload`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: formData
    })
    // console.log('uploadStrapiImage ready', pics.length) // eslint-disable-line no-console
    return pics[0]
  } catch (error) {
    throw new Error(error)
  }
}

export async function refreshStrapiImageFileInfo(id, fileInfo) {
  console.log('ID', id)
  console.log('fileinfo', fileInfo)
  const token = await getStrapiToken()

  const formData = new FormData()
  formData.append('fileInfo', fileInfo)

  try {
    console.log('uploadStrapiImage') // eslint-disable-line no-console
    const pics = await $fetch(`${config.strapiUrl}/upload/?id=${id}&meow=2`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: formData
    })
    // console.log('uploadStrapiImage ready', pics.length) // eslint-disable-line no-console
    return pics[0]
  } catch (error) {
    throw new Error(error)
  }
}

export async function deleteStrapiImage (fileId) {
  const token = await getStrapiToken()
  const formData = new FormData()

  try {
    console.log('deleteStrapiImage') // eslint-disable-line no-console
    const pics = await $fetch(`${config.strapiUrl}/upload/files/${fileId}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` },
    })
    return pics[0]
  } catch (error) {
    throw new Error(error)
  }
}

export async function setStrapiMyFilm (user, cassetteId) {
  if (!cassetteId) return null
  if (!user) return null

  const token = await getStrapiToken()
  const My = user.My || { films: [] }
  const myFilms = (My.films || []).map(film => ({ id: film.id }))

  // If the cassette was already in the user's favorites, remove it. Otherwise, add it.
  const index = myFilms.findIndex(film => film.id === cassetteId)
  console.log('setStrapiMyFilm', { user: user.id, count: myFilms.length, action: index === -1 ? 'add' : 'remove', cassette: cassetteId }) // eslint-disable-line no-console
  if (index > -1) {
    myFilms.splice(index, 1)
  } else {
    myFilms.push({ id: cassetteId })
  }

  My.films = myFilms

  // TODO: Use setStrapiMy
  // Update user's favorites list
  const result = await $fetch(`${config.strapiUrl}/users/${user.id}`, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: {
      id: user.id,
      My
    }
  })

  return result.My
}

export async function setStrapiMyScreening (user, screeningId) {
  if (!screeningId) return null
  if (!user) return null

  const token = await getStrapiToken()
  const My = user.My || { screenings: [] }
  const myScreenings = (My.screenings || []).map(screening => ({ id: screening.id }))

  // If the screening was already in the user's screenings, remove it. Otherwise, add it.
  const index = myScreenings.findIndex(screening => screening.id === screeningId)
  console.info('setStrapiMyScreening', { user: user.id, count: myScreenings.length, action: index === -1 ? 'add' : 'remove', screening: screeningId }) // eslint-disable-line no-console
  if (index > -1) {
    myScreenings.splice(index, 1)
  } else {
    myScreenings.push({ id: screeningId })
  }

  My.screenings = myScreenings

  // TODO: Use setStrapiMy
  // Update user's screenings list
  const result = await $fetch(`${config.strapiUrl}/users/${user.id}`, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: {
      id: user.id,
      My
    }
  })

  return result.My
}

export async function setStrapiMyCourseEvent (user, courseEventId) {
  if (!courseEventId) return null
  if (!user) return null

  const token = await getStrapiToken()
  const My = user.My || { course_events: [] }
  const myCourseEvents = (My.course_events || []).map(ce => ({ id: ce.id }))

  // If the course event was already in the user's course events, remove it. Otherwise, add it.
  const index = myCourseEvents.findIndex(ce => ce.id === courseEventId)
  console.info('setStrapiMyCourseEvent', { user: user.id, count: myCourseEvents.length, action: index === -1 ? 'add' : 'remove', courseEvent: courseEventId }) // eslint-disable-line no-console
  if (index > -1) {
    myCourseEvents.splice(index, 1)
  } else {
    myCourseEvents.push({ id: courseEventId })
  }

  My.course_events = myCourseEvents

  const result = await $fetch(`${config.strapiUrl}/users/${user.id}`, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: {
      id: user.id,
      My
    }
  })

  return result.My
}

export async function setStrapiMy (user) {
  if (!user) return null
  user.My = user.My || {}

  const token = await getStrapiToken()

  const result = await $fetch(`${config.strapiUrl}/users/${user.id}`, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: {
      id: user.id,
      My: user.My,
      my_products: user.my_products || [],
      my_films: user.my_films || [],
      my_screenings: user.my_screenings || []
    }
  })

  return result.My
}

export async function setFavorites (user, favorites) {
  if (!favorites) return null
  if (!user) return null

  const token = await getStrapiToken()

  favorites.userId = user.id

  // console.log('setFavorites', favorites)

  // Update user's favorites list
  const result = await $fetch(`${config.strapiUrl}/users/favorites/`, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: favorites
  })

  return result.My
}

export function getAdminBearer (event) {
  const headers = getRequestHeaders(event)

  const token = headers?.authorization?.split(' ')[1]

  if (!token) throw createError({ statusCode: 401, statusMessage: 'Unauthorized' })

  return token
}

export function getUserIdFromEvent (event) {
  const headers = getRequestHeaders(event)

  const token = headers?.authorization?.split(' ')[1]

  if (!token) throw createError({ statusCode: 401, statusMessage: 'Unauthorized' })

  try {
    const { sub } = jwt.verify(token, config.jwtSecret)
    return parseInt(sub)
  } catch (error) {
    throw createError({ statusCode: 401, statusMessage: 'Invalid token' })
  }
}

export function getUserIdFromToken (token) {

  if (!token) throw createError({ statusCode: 401, statusMessage: 'Unauthorized' })

  try {
    const { sub } = jwt.verify(token, config.jwtSecret)
    return parseInt(sub)
  } catch (error) {
    throw createError({ statusCode: 401, statusMessage: 'Invalid token' })
  }
}

async function getStrapiToken () {
  // If a cached token exists, and it's not expired, return it
  if (STRAPI_TOKEN.token && STRAPI_TOKEN.expires > Date.now()) {
    return STRAPI_TOKEN.token
  } else {
    return await refreshStrapiToken()
  }
}

async function getStrapiAdminToken () {
  // If a cached token exists, and it's not expired, return it
  if (STRAPI_ADMIN_TOKEN.token && STRAPI_ADMIN_TOKEN.expires > Date.now()) {
    return STRAPI_ADMIN_TOKEN.token
  } else {
    return await refreshStrapiAdminToken()
  }
}

async function refreshStrapiAdminToken () {
  const result = await $fetch(`${config.strapiUrl}/admin/login`, {
    method: 'POST',
    body: {
      email: config.strapiAdminUser,
      password: config.strapiAdminPassword
    }
  })

  const token = result.data.token

  STRAPI_ADMIN_TOKEN.token = token
  // Read expiration from token and subtract 5 minutes
  STRAPI_ADMIN_TOKEN.expires = (jwt.decode(token).exp - 5 * 60) * 1e3
  return token
}

async function refreshStrapiToken () {
  const { jwt: token } = await $fetch(`${config.strapiUrl}/auth/local`, {
    method: 'POST',
    body: {
      identifier: config.strapiUser,
      password: config.strapiPassword
    }
  })
  STRAPI_TOKEN.token = token
  // Read expiration from token and subtract 5 minutes
  STRAPI_TOKEN.expires = (jwt.decode(token).exp - 5 * 60) * 1e3
  return token
}

function getUserObject (user) {
  const result = {
    id: user.id.toString(),
    email: user.email,
    confirmed: user.confirmed === true,
    profile: user.profileFilled === true
  }

  if (user.user_profile?.firstName) result.firstName = user.user_profile.firstName
  if (user.user_profile?.lastName) result.lastName = user.user_profile.lastName

  return result
}

export async function getStrapiFilms (limit, page) {
  const token = await getStrapiToken()
  // set default limit and page values
  limit = limit || 5
  page = page || 1
  // console.log('getStrapiFilms', limit, page)

  const options = {
    headers: { Authorization: `Bearer ${token}` },
    query: {
      _limit: limit,
      _start: (page - 1) * limit
    }
  }
  return await $fetch(`${config.strapiUrl}/films`, options)
}

export async function getStrapiCassettes (limit, page) {
  const token = await getStrapiToken()
  // set default limit and page values
  limit = limit || 5
  page = page || 1
  // console.log('getStrapiCassettes', limit, page)

  const options = {
    headers: { Authorization: `Bearer ${token}` },
    query: {
      _limit: limit,
      _start: (page - 1) * limit
    }
  }
  return await $fetch(`${config.strapiUrl}/cassettes`, options)
}

export async function getStrapiCinemas () {
  const token = await getStrapiToken()
  // console.log('getStrapiCinemas', token)
  return await $fetch(`${config.strapiUrl}/cinemas`, { headers: { Authorization: `Bearer ${token}` } })
}

export async function getStrapiFilm (id) {
  const token = await getStrapiToken()

  return await $fetch(`${config.strapiUrl}/films/${id}`, { headers: { Authorization: `Bearer ${token}` } })
}

export async function getPaymentMethods (id) {
  // eslint-disable-next-line no-console
  console.log('getPaymentMethods')
  const token = await getStrapiToken()
  return await $fetch(`${config.strapiUrl}/users-permissions/users/paymentmethods/${id}`, { headers: { Authorization: `Bearer ${token}` } })
}

export async function buyProduct (body) {
  // eslint-disable-next-line no-console
  console.log('strapi:buyProduct', body)
  const token = await getStrapiToken()

  const result = await $fetch(`${config.strapiUrl}/users-permissions/users/buyproduct/`, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body
  })

  return result
}

export async function roleCheck (body) {
  // console.log('roleCheck', body)
  const token = await getStrapiToken()

  const result = await $fetch(`${config.strapiUrl}/users-permissions/users/rolecheck`, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body
  })

  return result
}

export async function linkStrapiUser (mainUserId, aliasUserId) {
  if (!mainUserId) return null
  if (!aliasUserId) return null

  const token = await getStrapiToken()

  const result = await $fetch(`${config.strapiUrl}/user/link`, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: {
      mainUser: mainUserId,
      aliasUser: aliasUserId
    }
  })

  return result
}

const makeUnique = (arr, prop) => {
  const obj = {}
  return Object.keys(arr.reduce((prev, next) => {
    if (!obj[next[prop]]) obj[next[prop]] = next
    return obj
  }, obj)).map(i => obj[i])
}

export async function mergeUserMy (user) {
  const aliasIds = [];
  var aliasUsers = [];

  user.aliasUsers.forEach(alias =>{
    aliasIds.push(alias.id)
  })

  if(aliasIds.length){
    aliasUsers = await getStrapiCollections(aliasIds, 'users')
  }

  user.My = user.My || {}
  const products = [...(user.My.products || []), ...(user.my_products || [])]
  const films = [...(user.My.films || []), ...(user.my_films || [])]
  const screenings = [...(user.My.screenings || []), ...(user.my_screenings || [])]

  aliasUsers.forEach(alias =>{
    alias.My = alias.My || {}
    products.push(...(alias.My.products || []))
    products.push(...(alias.my_products || []))

    films.push(...(alias.My.films || []))
    films.push(...(alias.my_films || []))

    screenings.push(...(alias.My.screenings || []))
    screenings.push(...(alias.my_screenings || []))
  })

  user.My.products = makeUnique(products, 'id')
  user.My.films = makeUnique(films, 'id')
  user.My.screenings = makeUnique(screenings, 'id')

  return user
}

export async function createStrapiPerson (user) {
  if (!user) return null
  const token = await getStrapiToken()

  // if missing profile, create it first
  if (!user.user_profile) {
    // eslint-disable-next-line no-console
    console.log('api::createStrapiPerson - creating profile for user', user.id)
    user.user_profile = await createStrapiUserProfile(user)
  }
  const profile = user.user_profile

  const createPerson = {
    firstName: profile.firstName,
    lastName: profile.lastName,
    firstNameLastName: `${profile.firstName} ${profile.lastName}`,
    eMail: profile.email,
    phoneNr: profile.phoneNr,
    profile_img: profile.picture,
    country: profile.country,
    festival_editions: [FESTIVAL_EDITION_CREATIVE_GATE_ID]
  }
  // eslint-disable-next-line no-console
  console.log('createStrapiPerson create', createPerson.firstNameLastName)

  const person = await $fetch(`${config.strapiUrl}/people`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: createPerson
  })

  console.log('createStrapiPerson created', createPerson.firstNameLastName)

  await $fetch(`${config.strapiUrl}/users/${user.id}`, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: {
      id: user.id,
      person: person.id
    }
  })

  console.log('createStrapiPerson user updated')

  return person
}

export async function getStrapiPerson (id) {
  if (!id) return null
  const token = await getStrapiToken()

  const url = `${config.strapiUrl}/people/${id}`
  const person = await $fetch(url, {
    headers: { Authorization: `Bearer ${token}` }
  })
  return person
}

export async function setStrapiPerson (personData) {
  if (!personData) return null
  const token = await getStrapiToken()

  console.log('setStrapiPerson', personData.id)
  const url = `${config.strapiUrl}/people/${personData.id}`
  console.log('setStrapiPerson url', url)
  const person = await $fetch(url, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: personData
  })
  console.log('setStrapiPerson returning', person.firstNameLastName)
  return person
}

export async function getStrapiFilmographies (ids) {
  return getStrapiCollections(ids, 'filmographies')
}

export async function getStrapiClients(ids) {
  return getStrapiCollections(ids,'clients')
}

export async function getStrapiCollections(ids, apiEndpoint) {
  if (!ids) return null
  const token = await getStrapiToken()

  var params = new URLSearchParams();
  for (const id of ids) {
    params.append("id_in", id);
  }

  const url = `${config.strapiUrl}/${apiEndpoint}?` + params.toString()
  const collections = await $fetch(url, {
    headers: { Authorization: `Bearer ${token}` }
  })
  return collections
}



export async function getStrapiOrganisationByField(field, name) {
  if (!name) return null
  const token = await getStrapiToken()

  var params = new URLSearchParams();
  params.append(`${field}_in`, name);

  const url = `${config.strapiUrl}/organisations?` + params.toString()
  const organisations = await $fetch(url, {
    headers: { Authorization: `Bearer ${token}` }
  })

  if (organisations.length) {
     return organisations[0]
  }

  const organisation = await createStrapiOrganisationWithData({
    'namePrivate': name,
    'name_et': name,
    'name_en': name,
    'name_ru': name
  })
  console.log('getStrapiOrganisationByField CREATED', organisation)
  return organisation
}

export async function getStrapiOrganisation (id) {
  if (!id) return null
  const token = await getStrapiToken()

  const url = `${config.strapiUrl}/organisations/${id}`
  const organisation = await $fetch(url, {
    headers: { Authorization: `Bearer ${token}` }
  })
  return organisation
}

export async function setStrapiOrganisation(organisationData) {
  if (!organisationData) return null
  const token = await getStrapiToken()

  console.log('setStrapiOrganisation', organisationData.id)
  const url = `${config.strapiUrl}/organisations/${organisationData.id}`
  console.log('setStrapiOrganisation url', url)
  const organisation = await $fetch(url, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: organisationData
  })
  return organisation
}

export async function createStrapiOrganisationWithData(data) {
  console.log('createStrapiOrganisationWithData')
  console.log(data)
  const token = await getStrapiToken()

  const organisation = await $fetch(`${config.strapiUrl}/organisations`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: data
  })

  console.log('createStrapiOrganisation created', organisation.id)
  return organisation
}

export async function createStrapiOrganisation (user) {
  if (!user) return null
  const token = await getStrapiToken()

  const organisation = await $fetch(`${config.strapiUrl}/organisations`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: {
      festival_editions: [FESTIVAL_EDITION_CREATIVE_GATE_ID]
    }
  })

  console.log('createStrapiOrganisation created', organisation.id)

  await $fetch(`${config.strapiUrl}/users/${user.id}`, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: {
      id: user.id,
      organisations: [organisation.id]
    }
  })

  console.log('createStrapiOrganisation user updated')

  return [organisation]
}

export async function postStrapiCollection (collectionName, collectionData) {
  if (!collectionName) {
    console.info('postStrapiCollection collectionName is null') // eslint-disable-line no-console
    return null
  }
  console.info('postStrapiCollection collectionName', collectionName) // eslint-disable-line no-console
  if (!collectionData) {
    console.info('postStrapiCollection collectionData is null') // eslint-disable-line no-console
    return null
  }
  const token = await getStrapiToken()

  const url = `${config.strapiUrl}/${collectionName}`
  console.info('postStrapiCollection POST to url', url) // eslint-disable-line no-console
  const result = await $fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: collectionData
  })
  console.info('postStrapiCollection returning', collectionName, result) // eslint-disable-line no-console
  return result
}

export async function putStrapiCollection (collectionName, collectionData) {
  if (!collectionName) {
    console.info('putStrapiCollection collectionName is null') // eslint-disable-line no-console
    return null
  }
  console.info('putStrapiCollection collectionName', collectionName) // eslint-disable-line no-console
  if (!collectionData) {
    console.info('putStrapiCollection collectionData is null') // eslint-disable-line no-console
    return null
  }
  if (!collectionData.id) {
    console.info('putStrapiCollection missing id in collectionData') // eslint-disable-line no-console
    return null
  }
  const token = await getStrapiToken()

  const url = `${config.strapiUrl}/${collectionName}/${collectionData.id}`
  console.info('putStrapiCollection PUT to url', url) // eslint-disable-line no-console
  const result = await $fetch(url, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: collectionData
  }).catch((err) => console.log('ERROR:', err.data, collectionData));
  //console.info('putStrapiCollection returning', collectionName, result) // eslint-disable-line no-console
  return result
}


export async function getUniqSlug (slug, contentTypeUID, field) {
  try {
    const token = await getStrapiToken()
    const url = `${config.strapiUrl}/content-manager/uid/check-availability`
    const result = await $fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: {
        contentTypeUID: contentTypeUID,
        field: field,
        value: slug
      }
    })
    if (!result.isAvailable && result.suggestion) {
      return result.suggestion
    }
  } catch (error) {
    console.log('getUniqSlug error:', error)
  }
  return slug
}
