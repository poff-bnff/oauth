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

export async function getStrapiSingleUser (userId) {
  if (!userId) return null
  const token = await getStrapiToken() // Assuming this returns a general token

  // Fetch the user's current data, crucial for getting existing user_roles
  return await $fetch(`${config.strapiUrl}/users/${userId}`, {
    headers: {
      Authorization: `Bearer ${token}`
    }
  })
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

// --- CONFIGURATION/UTILITY FUNCTIONS (Assume these are available globally or imported) ---
// const config = { strapiUrl: '...', fionaApiKey: '...' };
// const $fetch = async (url, options) => { ... };
// const getStrapiToken = async () => { ... };
// const getStrapiAdminToken = async () => { ... };

// A simple delay utility for retry logic
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

// --- STRAPI ROLE UTILITY ---

export async function getStrapiUserRoles () {
  const token = await getStrapiAdminToken()

  // NOTE: This call only needs to happen once per run
  return await $fetch(`${config.strapiUrl}/user-roles`, { headers: { Authorization: `Bearer ${token}` } })
}

export async function setStrapiUserRoles (userId, roleIds) {
  if (!userId || !Array.isArray(roleIds)) return null

  // Ensure you are using a token with permission to update users and their custom relations (user_roles)
  const token = await getStrapiToken()

  return await $fetch(`${config.strapiUrl}/users/${userId}`, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    // Only send the custom user_roles field with an array of IDs
    body: {
      user_roles: roleIds
    }
  })
}

// --- FIONA BADGE FETCHING (With Resilience/Retry) ---

export async function fetchFionaBadges (guestbookId, userId) {
  if (!guestbookId || !userId) return []

  const token = config.fionaApiKey
  const options = {
    headers: {
      'X-ApiKey': token
    },
    method: 'GET'
  }
  const url = `https://poff-xapi.fiona-app.com/api/account/MyPoff/${userId}/guestbook/${guestbookId}/badges`

  // --- RETRY LOGIC for External API Failure ---
  const MAX_RETRIES = 3
  let fionaBadges = []

  for (let i = 0; i < MAX_RETRIES; i++) {
    try {
      // Use a timeout option if $fetch supports it, to prevent infinite hang
      fionaBadges = await $fetch(url, options)
      break // Success!
    } catch (err) {
      // Check for common network/DNS errors (EAI_AGAIN, ENOTFOUND, network timeouts)
      const isRetryable = err.code === 'EAI_AGAIN' || err.code === 'ENOTFOUND' || err.name === 'FetchError'

      if (i === MAX_RETRIES - 1 || !isRetryable) {
        console.error(`Fiona fetch failed after ${i + 1} attempts for ${url}. Aborting.`, err)
        throw err // Re-throw the original error
      }

      // Wait a bit longer on each retry attempt (Exponential backoff)
      console.warn(`Retry attempt ${i + 1} failed for ${url} (Error: ${err.code || err.name}). Retrying...`)
      await delay(500 * (i + 1))
    }
  }
  // --- END RETRY LOGIC ---

  // 1. Group the badges by name and collect unique statuses using a Map/Object
  const groupedBadgesMap = fionaBadges.reduce((acc, badge) => {
    const badgeName = badge.GuestbookBadge?.Description;
    const statusDescription = badge.Status?.Description;

    if (!badgeName || !statusDescription) {
        return acc;
    }

    if (!acc[badgeName]) {
      acc[badgeName] = {
        badge_name: badgeName,
        statuses: new Set()
      };
    }
    acc[badgeName].statuses.add(statusDescription);

    return acc;
  }, {});

  // 2. Convert the grouped object (which contains Sets) into the final array format
  const finalBadgesArray = Object.values(groupedBadgesMap).map(item => ({
    badge_name: item.badge_name,
    statuses: Array.from(item.statuses)
  }));

  return finalBadgesArray;
}

async function getActiveFionaGuestbooks () {
  const token = await getStrapiToken()

  const today = new Date().toISOString().slice(0, 10) // YYYY-MM-DD
  const params = new URLSearchParams()
  params.append('validUntil_gt', today)
  params.append('validFrom_lte', today)

  const festivals = await $fetch(`${config.strapiUrl}/festival-editions?${params.toString()}`, {
    headers: { Authorization: `Bearer ${token}` }
  })

  const guestbookIds = [...new Set(
    festivals
      .map(f => f?.guestbook_id)
      .filter(id => id !== null && id !== undefined)
  )]

  return guestbookIds
}

export async function loadFionaBadges (user) {
  const mainUserId = user.id
  const aliasUserIds = Array.isArray(user.aliasUsers) && user.aliasUsers.length
    ? user.aliasUsers.map(u => u.id)
    : []
  const allIds = [mainUserId, ...aliasUserIds]

  const consolidatedBadgesMap = new Map()
  const guestbooks = await getActiveFionaGuestbooks()

  for (const guestbookId of guestbooks) {
    for (const id of allIds) {
      try {
        const fionaBadges = await fetchFionaBadges(guestbookId, id)

        if (Array.isArray(fionaBadges) && fionaBadges.length) {
          for (const badge of fionaBadges) {
            const existingBadge = consolidatedBadgesMap.get(badge.badge_name)

            if (existingBadge) {
              const mergedStatuses = [...existingBadge.statuses, ...badge.statuses]
              const uniqueStatuses = Array.from(new Set(mergedStatuses))
              existingBadge.statuses = uniqueStatuses
            } else {
              consolidatedBadgesMap.set(badge.badge_name, { ...badge })
            }
          }
        }
      } catch (err) {
        // Log the individual fetch error, but the overall loadFionaBadges continues
        console.error('loadFionaBadges error (single ID/guestbook fetch failed)', { guestbookId, id, err })
      }
    }
  }

  user.badges = Array.from(consolidatedBadgesMap.values())

  return user
}


// --- ROLE VALIDATION LOGIC ---

// A helper function to check if a user has a specific badge and status (kept unchanged)
function userHasMatchingBadge (userBadges, requiredBadgeName, requiredBadgeStatuses) {
  const userBadge = userBadges.find(
    badge => badge.badge_name === requiredBadgeName
  )
  if (!userBadge) return false
  const requiredStatusesArray = requiredBadgeStatuses.split(',').map(s => s.trim()).filter(s => s.length > 0)
  const userStatuses = userBadge.statuses
  return requiredStatusesArray.some(requiredStatus => userStatuses.includes(requiredStatus))
}

/**
 * Filters the roles based on badges for a given user object.
 * @param {Object} user - The user object with aggregated badges.
 * @param {Array<Object>} allStrapiRoles - The pre-fetched list of all available Strapi roles.
 * @param {Array<Object>} existingUserRoles - The roles currently assigned to the user.
 * @param {boolean} isAlias - Flag to exclude badge-based roles for alias users.
 * @returns {Array<number>} An array of Role IDs to be assigned.
 */
export async function validateUserRoles (user, allStrapiRoles, existingUserRoles, isAlias = false) {
  const userBadges = user.badges || []
  const rolesToAssign = []

  // Create a quick lookup set for the IDs of the user's existing roles
  const existingRoleIds = new Set(existingUserRoles.map(role => role.id));

  for (const role of allStrapiRoles) {
    const roleHasBadgesDefined = Array.isArray(role.user_badges) && role.user_badges.length > 0

    // Requirement 3: Skip badge-based roles for aliases
    if (isAlias && roleHasBadgesDefined) {
        continue;
    }

    if (roleHasBadgesDefined) {
      // **Process Badge-Based Roles** (Always ADD if criteria met)

      let roleIsAssignedByBadge = false

      for (const requiredBadge of role.user_badges) {
        if (
          userHasMatchingBadge(
            userBadges,
            requiredBadge.badgeName,
            requiredBadge.badgeStatuses
          )
        ) {
          rolesToAssign.push(role)
          roleIsAssignedByBadge = true
          break
        }
      }
    } else {
      // **Process Non-Badge Roles** (PRESERVE if already assigned)

      // ONLY push this role if the user ALREADY has it assigned.
      if (existingRoleIds.has(role.id)) {
        rolesToAssign.push(role)
      }
    }
  }

  return rolesToAssign.map(role => role.id)
}

/**
 * Checks if two arrays of role IDs are identical, regardless of order.
 * @param {Array<number>} array1 - The newly calculated role IDs.
 * @param {Array<number>} array2 - The existing role IDs from Strapi.
 * @returns {boolean} True if both arrays contain the same IDs, false otherwise.
 */
function areRoleArraysEqual (array1, array2) {
  if (array1.length !== array2.length) {
    return false;
  }

  // Convert one array to a Set for efficient lookup
  const set1 = new Set(array1);

  // Check if every element in array2 is present in set1
  return array2.every(id => set1.has(id));
}

// --- MASTER ORCHESTRATOR (Updated for Optimization and Resilience) ---

export async function updateUserAndAliasesRoles (mainUser) {
  const aliasUsers = Array.isArray(mainUser.aliasUsers) ? mainUser.aliasUsers : []
  let allStrapiRoles = []

  // 1. Fetch ALL Strapi roles ONCE (Optimization)
  try {
    allStrapiRoles = await getStrapiUserRoles()
  } catch (err) {
    console.error('CRITICAL: Failed to fetch Strapi roles. Aborting role validation.', err)
    return mainUser
  }

  // 2. Load/Aggregate all badges ONTO the main user object (Resilience)
  let userWithBadges = mainUser;
  let allUserBadges = [];

  try {
    userWithBadges = await loadFionaBadges(mainUser)
    allUserBadges = userWithBadges.badges || []
  } catch (err) {
    console.error('Non-critical: Total failure fetching Fiona badges. Roles will only include non-badge-dependent roles.', err)
    userWithBadges.badges = []
  }

  // --- Process Main User ---
  const mainUserId = mainUser.id;

  // 3. Fetch current user details to get existing roles
  const mainUserCurrentDetails = await getStrapiUser(mainUserId)
  const mainUserExistingRoles = mainUserCurrentDetails?.user_roles || []
  const mainUserExistingRoleIds = mainUserExistingRoles.map(role => role.id); // Array of current IDs

  // 4. Validate roles
  const mainUserRoleIds = await validateUserRoles(
    userWithBadges,
    allStrapiRoles,
    mainUserExistingRoles,
    false
  )

  // 5. Compare and conditionally update (NEW LOGIC)
  if (mainUserId && !areRoleArraysEqual(mainUserRoleIds, mainUserExistingRoleIds)) {
    try {
      await setStrapiUserRoles(mainUserId, mainUserRoleIds)
      console.log(`✅ Successfully updated roles (CHANGE DETECTED) for Main User ID: ${mainUserId}`)
    } catch (error) {
      console.error(`Error updating roles for Main User ID: ${mainUserId}`, error)
    }
  } else {
    console.log(`ℹ️ Roles for Main User ID: ${mainUserId} are up-to-date. Skipping update.`)
  }

  // --- Process Alias Users ---
  for (const alias of aliasUsers) {
    const aliasId = alias.id;

    // 6. Fetch current alias details to get existing roles
    const aliasCurrentDetails = await getStrapiUser(aliasId)
    const aliasExistingRoles = aliasCurrentDetails?.user_roles || []
    const aliasExistingRoleIds = aliasExistingRoles.map(role => role.id); // Array of current IDs

    const aliasUserContext = {
        id: aliasId,
        badges: allUserBadges
    }

    // 7. Validate alias roles
    const aliasRoleIds = await validateUserRoles(
      aliasUserContext,
      allStrapiRoles,
      aliasExistingRoles,
      true
    )

    // 8. Compare and conditionally update (NEW LOGIC)
    if (aliasId && !areRoleArraysEqual(aliasRoleIds, aliasExistingRoleIds)) {
      try {
          await setStrapiUserRoles(aliasId, aliasRoleIds)
          console.log(`✅ Successfully updated roles (CHANGE DETECTED) for Alias User ID: ${aliasId}`)
      } catch (error) {
          console.error(`Error updating roles for Alias User ID: ${aliasId}`, error)
      }
    } else {
      console.log(`ℹ️ Roles for Alias User ID: ${aliasId} are up-to-date. Skipping update.`)
    }
  }

  mainUser.user_roles = mainUserRoleIds
  return mainUser
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

/**
 * Retrieves user context data, prioritizing the main user's profile for names,
 * but always using the base user's ID/Email for identification.
 * Ensures the profile for the profile source user (main or base) exists.
 *
 * @param {string | number} baseUserId The ID of the currently queried user (the base user).
 * @param {string} token The Strapi authorization token.
 * @returns {Promise<object>} The merged user context data.
 */
export async function getStrapiUserForFiona (baseUserId, token) {
  if (!baseUserId) {
    throw createError({ statusCode: 404, statusMessage: 'No user ID provided' })
  }

  // 1. Fetch the Base User (the current session user, providing ID/Email)
  const baseUser = await $fetch(`${config.strapiUrl}/users/${baseUserId}`, {
    headers: { Authorization: `Bearer ${token}` }
  })
  if (!baseUser) {
    throw createError({ statusCode: 404, statusMessage: `No user with ID ${baseUserId}` })
  }

  // Set the default source for profile data to the base user
  let profileSourceUser = baseUser
  let sourceUserProfile = baseUser.user_profile

  // 2. Check for Main User Link
  if (baseUser.mainUser && baseUser.mainUser.id) {
    const mainUserId = baseUser.mainUser.id

    // Fetch the Main User record
    const mainUser = await $fetch(`${config.strapiUrl}/users/${mainUserId}`, {
      headers: { Authorization: `Bearer ${token}` }
    })

    // If the main user is found, use them as the source for profile names
    if (mainUser) {
      profileSourceUser = mainUser
      sourceUserProfile = mainUser.user_profile
    }
    // If the main user fetch fails, we fall back to using the base user profile,
    // ensuring names are always sourced, even if the main link is broken.
  }

  // 3. Ensure the Profile exists for the designated Source User (main or base)
  if (sourceUserProfile === null) {
    // Create profile for the user we are sourcing name/lastname from
    // eslint-disable-next-line no-console
    console.log('api::getStrapiUser - creating profile for user', profileSourceUser.id)
    sourceUserProfile = await createStrapiUserProfile(profileSourceUser)
  }

  // 4. Construct the Final Output
  const data = {
    // ID: ALWAYS from the CURRENTLY queried user (baseUser)
    id: baseUser.id,

    // Email: ALWAYS from the CURRENTLY queried user (baseUser),
    // using the original logic which checks the email property.
    emailAddress: baseUser.email,

    // Name/Lastname: ALWAYS from the SOURCE USER's profile (mainUser or baseUser)
    lastname: sourceUserProfile.lastName,
    firstname: sourceUserProfile.firstName
  }

  return data
}

export async function getStrapiUser(id) {
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

export async function getStrapiIndividual (id) {
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

  if (user.mainUser) {
    const mainUser =  await getStrapiUser(user.mainUser.id)

    if(mainUser){
      user.user_profile = mainUser.user_profile
    }
  }

  if (user.user_profile !== null) {
    // remove properties with null values from profile
    Object.keys(user.user_profile).forEach(key => user.user_profile[key] === null && delete user.user_profile[key])
    Object.keys(user).forEach(key => user[key] === null && delete user[key])
  }

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
    user: user.id,
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
  const url = `${config.strapiUrl}/people/addpro/${personData.id}`
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
  const url = `${config.strapiUrl}/organisations/addpro/${organisationData.id}`
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
      festival_editions: [FESTIVAL_EDITION_CREATIVE_GATE_ID],
      user: user.id
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
      organisation: organisation.id
    }
  })

  console.log('createStrapiOrganisation user updated')

  return organisation
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


export async function getUniqSlug(slug, contentTypeUID, field) {
  //  grep -r -P "^path: " . | grep -v _fetchdir | grep source | awk -F': ' '{print "\""$2"\","}' | uniq
  const reserverdSlugs = [
      "artikkel", "about", "artikl", "intervjuud", "interviews",
      "projects", "industry-projects", "toetajad", "supporters", "supportersru",
      "featured-persons-archive", "toetajalood", "sponsorstories", "sponsorstoriesru", "shop",
      "filmid", "films", "filmy", "discamp-events-search", "my-events",
      "otsi_filmi", "search_film", "iskat_film", "news", "mycalendar",
      "search-projects", "minu_seansid", "my_screenings", "moi_seanss", "locations",
      "menu2", "praktika", "training_positions", "praktika_ru", "kursused",
      "courses", "sockets", "filmikool-courses-search", "otsi_seanssi", "search_screening",
      "iskat_seanss", "whos-here", "otsi_filmi_arhiivist", "search_film_archive", "iskat_film_arhiv",
      "virtual-booth", "menu", "locations-search", "letschat", "creative_gate",
      "dc-persons", "programmid", "programmes", "programmy", "persons-search",
      "search-projects-archive", "persons-search-cg", "poff-soovitab", "poff-soovitab-en", "poff-soovitab-ru",
      "screenings", "minupoff", "mypoff", "moipoff", "my_profile",
      "cg_uudised", "cg_news", "cg_novosti", "industry-events-search", "uudised",
      "news", "novosti"
  ]
  try {
    if (reserverdSlugs.includes(slug.toLowerCase())) {
      slug = slug + '-1'
    }
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
