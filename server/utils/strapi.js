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
  const token = await getStrapiAdminToken()

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
  const token = await getStrapiAdminToken()

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
  const token = await getStrapiAdminToken()
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
  const token = await getStrapiAdminToken()

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

  const token = await getStrapiAdminToken()
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

export async function getStrapiToken () {
  // If a cached token exists, and it's not expired, return it
  if (STRAPI_TOKEN.token && STRAPI_TOKEN.expires > Date.now()) {
    return STRAPI_TOKEN.token
  } else {
    return await refreshStrapiToken()
  }
}

export async function getStrapiAdminToken () {
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
  console.log('getPaymentMethods', id) // eslint-disable-line no-console
  if (id) await getStrapiCollectionItem('product-categories', id)

  const host = String(config.maksekeskusHost || 'https://api.test.maksekeskus.ee').replace(/\/$/, '')
  const mkUrl = host.startsWith('http') ? `${host}/v1/shop/configuration` : `https://${host}/v1/shop/configuration`
  const mkResponse = await $fetch(mkUrl, {
    method: 'GET',
    headers: {
      Authorization: `Basic ${Buffer.from(`${config.maksekeskusId}:${config.maksekeskusSecret}`).toString('base64')}`,
      'Content-Type': 'application/json'
    }
  })

  return {
    banklinks: normalizeMaksekeskusMethods(mkResponse.payment_methods?.banklinks || []),
    cards: normalizeMaksekeskusMethods(mkResponse.payment_methods?.cards || []),
    other: normalizeMaksekeskusMethods(mkResponse.payment_methods?.other || []),
    payLater: normalizeMaksekeskusMethods(mkResponse.payment_methods?.payLater || [])
  }
}

// Known display names for Maksekeskus payment method identifiers.
// The API returns raw lowercase keys (e.g. 'apple_pay', 'lhv'); this maps them to human labels.
const PAYMENT_METHOD_DISPLAY_NAMES = {
  swedbank: 'Swedbank',
  seb: 'SEB',
  lhv: 'LHV',
  luminor: 'Luminor',
  nordea: 'Nordea',
  coop_pank: 'Coop Pank',
  coop: 'Coop Pank',
  krediidipank: 'Krediidipank',
  visa: 'Visa',
  mastercard: 'Mastercard',
  'visa/mastercard': 'Visa / Mastercard',
  apple_pay: 'Apple Pay',
  google_pay: 'Google Pay',
  revolut: 'Revolut',
  paysera: 'Paysera',
  n26: 'N26',
  wise: 'Wise',
  slice: 'Slice',
  gift_card: 'Gift Card',
  hire_purchase: 'Hire purchase',
  liisi_hire_purchase: 'Liisi hire purchase',
  liisi_ee: 'Liisi',
  'indivy-go': 'Indivy Go'
}

function formatPaymentMethodName (name) {
  const lower = String(name || '').toLowerCase()
  if (PAYMENT_METHOD_DISPLAY_NAMES[lower]) return PAYMENT_METHOD_DISPLAY_NAMES[lower]
  // Generic fallback: replace _ and - separators with spaces, then title-case each word
  return lower
    .replace(/[_-]+/g, ' ')
    .replace(/\b\w/g, c => c.toUpperCase())
}

function normalizeMaksekeskusMethods (methods) {
  // The Maksekeskus test server has stale method names (e.g. 'nordea' shows
  // Luminor's logo; 'krediidipank' shows Coop Pank's logo). Using the logo
  // filename slug as the canonical key gives the correct brand in both test
  // and production environments. Deduplicate by resolved display name so the
  // same bank doesn't appear twice (test server returns many country variants).
  const seen = new Set()
  return methods
    .map(method => {
      const logoSlug = method.logo_url?.match(/\/([^/]+)\.[a-z]+$/i)?.[1]?.toLowerCase()
      const name = formatPaymentMethodName(logoSlug || method.name)
      return { id: buildMaksekeskusMethodId(method), name, country: method.country, logo: method.logo_url }
    })
    .filter(method => {
      if (seen.has(method.name)) return false
      seen.add(method.name)
      return true
    })
}

export async function buyProduct (body) {
  console.log('checkout:buyProduct', body) // eslint-disable-line no-console

  const userId = body.userId
  const categoryId = body.categoryId
  const paymentMethodId = body.paymentMethodId

  if (!userId) return { code: 401, case: 'unauthorized' }
  if (!categoryId) return { code: 400, case: 'noCategoryId' }
  if (!paymentMethodId) return { code: 400, case: 'noPaymentMethodId' }

  const buyer = await getStrapiUser(userId)
  const buyerProfile = buyer.user_profile || {}
  if (!hasCompleteCheckoutBuyerProfile(buyerProfile)) {
    return { code: 400, case: 'buyerProfileIncomplete', missing: missingBuyerProfileFields(buyerProfile) }
  }

  const product = await getAvailableCheckoutProduct(categoryId)
  if (!product) return { code: 404, case: 'noItems' }

  const productCategoryId = product.product_category?.id || product.product_category
  const productCategory = await getStrapiCollectionItem('product-categories', productCategoryId)
  const pickupLocations = productCategory?.pickup_locations || []
  const sellerBusinessProfile = product.product_category?.business_profile?.id || product.product_category?.business_profile || productCategory?.business_profile?.id || productCategory?.business_profile
  const price = getCheckoutProductCurrentPrice(product.product_category || productCategory)

  if (!price) return { code: 400, case: 'noCurrentPrice' }

  const billingProfileId = await validateCheckoutBusinessProfile(userId, body.billingProfileId || body.buyerBusinessProfileId)
  if (!billingProfileId) return { code: 400, case: 'invalidBillingProfile' }

  const deliveryLocationId = validateCheckoutDeliveryLocation(pickupLocations, body.deliveryLocationId)
  if (deliveryLocationId === false) return { code: 400, case: body.deliveryLocationId ? 'invalidDeliveryLocation' : 'noDeliveryLocation' }

  const ownerResult = await resolveCheckoutOwner(userId, productCategory, body.owner || { mode: 'me' })
  if (ownerResult.error) return { code: 400, case: ownerResult.error, missing: ownerResult.missing }

  const reserved = await reserveCheckoutProduct(product.id, userId, price)
  if (!reserved?.reserved_to) return { code: 500, case: 'reservationSaveFailed' }

  const userEmail = buyerProfile.email || buyer.email
  let mkResponse
  try {
    mkResponse = await createMaksekeskusTransaction({
      body,
      categoryId,
      product,
      productId: product.id,
      productCatSeller: sellerBusinessProfile,
      price,
      userId,
      userEmail,
      billingProfileId,
      deliveryLocationId,
      ownerResult
    })
  } catch (error) {
    await clearCheckoutProductReservation(product.id)
    throw error
  }

  const paymentMethod = [
    ...(mkResponse.payment_methods?.banklinks || []),
    ...(mkResponse.payment_methods?.cards || []),
    ...(mkResponse.payment_methods?.other || []),
    ...(mkResponse.payment_methods?.payLater || [])
  ].find(method => buildMaksekeskusMethodId(method) === paymentMethodId)

  if (!paymentMethod) return { code: 400, case: 'noPaymentMethod' }

  return { url: paymentMethod.url }
}

export function hasCompleteCheckoutBuyerProfile(profile = {}) {
  return !!(profile.email && profile.firstName && profile.lastName && profile.birthdate && profile.phoneNr && profile.gender && profile.picture)
}

export function missingBuyerProfileFields(profile = {}) {
  return ['email', 'firstName', 'lastName', 'birthdate', 'phoneNr', 'gender', 'picture'].filter(field => !profile[field])
}

function missingOwnerProfileFields(profile = {}) {
  return ['email', 'firstName', 'lastName', 'picture'].filter(field => !profile[field])
}

function normalizeCheckoutEmail(value) {
  return String(value || '').trim().toLowerCase()
}

function validCheckoutEmail(value) {
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(normalizeCheckoutEmail(value))
}

async function getStrapiCollectionItem(collection, id) {
  const token = await getStrapiAdminToken()
  return await $fetch(`${config.strapiUrl}/${collection}/${id}`, {
    headers: { Authorization: `Bearer ${token}` }
  })
}

async function getAvailableCheckoutProduct(categoryId) {
  const token = await getStrapiAdminToken()
  const params = new URLSearchParams()
  params.append('_limit', '1')
  params.append('code_null', 'false')
  params.append('reserved_to_null', 'true')
  params.append('owner_null', 'true')
  params.append('product_category_null', 'false')
  params.append('transactions_null', 'true')
  params.append('product_category.codePrefix', categoryId)
  params.append('active', 'true')

  const products = await $fetch(`${config.strapiUrl}/products?${params.toString()}`, {
    headers: { Authorization: `Bearer ${token}` }
  })
  return Array.isArray(products) ? products[0] : products
}

export function getCheckoutProductCurrentPrice(category) {
  const now = new Date()
  const prices = category?.priceAtPeriod || []
  const current = prices.find(item => item.startDateTime && item.endDateTime && new Date(item.startDateTime) < now && new Date(item.endDateTime) > now)
  return current?.price
}

async function validateCheckoutBusinessProfile(userId, billingProfileId) {
  if (!billingProfileId) return null
  const token = await getStrapiAdminToken()
  const params = new URLSearchParams()
  params.append('id', billingProfileId)
  params.append('_where[user]', userId)
  const profiles = await $fetch(`${config.strapiUrl}/business-profiles?${params.toString()}`, {
    headers: { Authorization: `Bearer ${token}` }
  })
  return Array.isArray(profiles) && profiles[0] ? profiles[0].id : null
}

export function validateCheckoutDeliveryLocation(pickupLocations, selectedLocationId) {
  const ids = (pickupLocations || []).map(location => String(location.id))
  if (!ids.length) return null
  if (!selectedLocationId) return false
  return ids.includes(String(selectedLocationId)) ? selectedLocationId : false
}

export async function validateCheckoutOwner(userId, categoryId, owner = {}) {
  const productCategory = await getStrapiCollectionItem('product-categories', categoryId)
  const result = await resolveCheckoutOwner(userId, productCategory, owner, { dryRun: true })
  if (result.error) return result
  return { ok: true, mode: result.mode, existing: result.existing === true }
}

async function resolveCheckoutOwner(userId, productCategory, owner = {}, options = {}) {
  const mode = owner.mode === 'gift' ? 'gift' : 'me'
  if (mode === 'me') return { userId, mode: 'me', sendEmail: false }

  if (productCategory?.transferable !== true) return { error: 'invalidOwner' }

  const email = normalizeCheckoutEmail(owner.email)
  const firstName = String(owner.firstName || '').trim()
  const lastName = String(owner.lastName || '').trim()
  if (!firstName || !lastName || !validCheckoutEmail(email)) return { error: 'invalidOwner' }

  const token = await getStrapiAdminToken()
  const existingUsers = await $fetch(`${config.strapiUrl}/users?email=${encodeURIComponent(email)}`, {
    headers: { Authorization: `Bearer ${token}` }
  })
  const existingUser = Array.isArray(existingUsers) ? existingUsers[0] : null

  if (existingUser) {
    const user = await getStrapiUser(existingUser.id)
    const missing = missingOwnerProfileFields(user.user_profile || {})
    if (missing.length) return { error: 'ownerProfileIncomplete', missing }
    return { userId: user.id, mode: 'gift', sendEmail: owner.sendEmail !== false, existing: true }
  }

  if (!owner.hasPhoto && !owner.photo?.data) return { error: 'ownerPhotoRequired' }
  if (options.dryRun) return { mode: 'gift', existing: false }

  const authUser = await authenticateStrapiUser(email)
  const user = await getStrapiUser(authUser.id)
  const picture = await uploadCheckoutOwnerPhoto(owner.photo, user.user_profile.id, email)
  if (!picture?.id) return { error: 'ownerPhotoRequired' }

  await setStrapiUserProfile(user.user_profile.id, {
    firstName,
    lastName,
    email,
    picture: picture.id
  })

  return { userId: user.id, mode: 'gift', sendEmail: owner.sendEmail !== false, existing: false }
}

async function uploadCheckoutOwnerPhoto(photo, profileId, email) {
  if (!photo?.data) return null
  const match = String(photo.data).match(/^data:([^;]+);base64,(.+)$/)
  if (!match || !match[1].includes('image/')) return null
  const buffer = Buffer.from(match[2], 'base64')
  if (!buffer.length || buffer.length > 5 * 1024 * 1024) return null
  const extension = (photo.name && photo.name.includes('.') ? photo.name.split('.').pop() : '') || match[1].split('/')[1] || 'jpg'
  const filename = `checkout-owner-${String(email).replace(/[^a-z0-9]+/gi, '-').toLowerCase()}.${extension}`
  return await uploadStrapiImage({ name: 'picture', filename, data: buffer }, 'user-profile', profileId)
}

async function reserveCheckoutProduct(productId, userId, price) {
  const token = await getStrapiAdminToken()
  const product = await $fetch(`${config.strapiUrl}/products/${productId}`, {
    headers: { Authorization: `Bearer ${token}` }
  })
  const reservedTo = product?.reserved_to?.id || product?.reserved_to || null
  if (reservedTo && String(reservedTo) !== String(userId)) return null
  if (product?.owner?.id || product?.owner) return null
  if (Array.isArray(product?.transactions) && product.transactions.length) return null

  return await $fetch(`${config.strapiUrl}/products/${productId}`, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: {
      reserved_to: userId,
      reservation_price: price,
      reservation_time: new Date().toISOString()
    }
  })
}

async function clearCheckoutProductReservation(productId, userId = null) {
  const token = await getStrapiAdminToken()
  if (userId) {
    const product = await $fetch(`${config.strapiUrl}/products/${productId}`, {
      headers: { Authorization: `Bearer ${token}` }
    })
    const reservedTo = product?.reserved_to?.id || product?.reserved_to || null
    if (String(reservedTo || '') !== String(userId)) return product
  }
  return await $fetch(`${config.strapiUrl}/products/${productId}`, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: {
      reserved_to: null,
      reservation_price: null,
      reservation_time: null
    }
  })
}

async function refreshCheckoutProductReservation(productId, userId, price) {
  const token = await getStrapiAdminToken()
  const product = await $fetch(`${config.strapiUrl}/products/${productId}`, {
    headers: { Authorization: `Bearer ${token}` }
  })
  const reservedTo = product?.reserved_to?.id || product?.reserved_to || null
  if (reservedTo && String(reservedTo) !== String(userId)) return null
  if (product?.owner?.id || product?.owner) return null
  if (Array.isArray(product?.transactions) && product.transactions.length) return null

  return await $fetch(`${config.strapiUrl}/products/${productId}`, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: {
      reserved_to: userId,
      reservation_price: price,
      reservation_time: new Date().toISOString()
    }
  })
}

async function createMaksekeskusTransaction({ body, categoryId, productId, productCatSeller, price, userId, userEmail, billingProfileId, deliveryLocationId, ownerResult }) {
  const host = String(config.maksekeskusHost || 'https://api.test.maksekeskus.ee').replace(/\/$/, '')
  const mkUrl = host.startsWith('http') ? `${host}/v1/transactions` : `https://${host}/v1/transactions`
  const mkId = config.maksekeskusId
  const mkSecret = config.maksekeskusSecret

  const postData = {
    customer: {
      email: userEmail,
      ip: body.ip || '',
      country: 'ee',
      locale: body.locale || 'et'
    },
    transaction: {
      amount: price,
      currency: 'EUR',
      merchant_data: JSON.stringify({
        userId,
        categoryId,
        productId,
        productCatSeller,
        selectedBillingProfileId: billingProfileId,
        deliveryLocationId,
        ownerUserId: ownerResult.userId,
        ownerMode: ownerResult.mode,
        ownerSendEmail: ownerResult.sendEmail === true,
        cancel_url: body.cancel_url,
        return_url: body.return_url
      }),
      reference: categoryId,
      transaction_url: {
        cancel_url: { method: 'POST', url: `${config.strapiUrl}/users-permissions/users/buyproductcb/cancel` },
        notification_url: { method: 'POST', url: `${config.strapiUrl}/users-permissions/users/buyproductcb/notification` },
        return_url: { method: 'POST', url: `${config.strapiUrl}/users-permissions/users/buyproductcb/return` }
      }
    }
  }

  try {
    const response = await $fetch(mkUrl, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${Buffer.from(`${mkId}:${mkSecret}`).toString('base64')}`,
        'Content-Type': 'application/json'
      },
      body: postData
    })
    return response
  } catch (error) {
    throw error
  }
}

function buildMaksekeskusMethodId(method) {
  return [method.country, method.name].join('_').toUpperCase()
}

async function getOrCreateStatusCollectionItem(collection, status) {
  const token = await getStrapiAdminToken()
  const fields = ['status', 'name']
  let supportedField = null

  for (const field of fields) {
    const result = await getStatusCollectionItemByField(collection, field, status, token)
    if (!result.supported) continue
    supportedField = field
    if (result.item) return result.item
    break
  }

  if (!supportedField) {
    throw createError({ statusCode: 500, statusMessage: `${collection} schema has neither status nor name field` })
  }

  return await $fetch(`${config.strapiUrl}/${collection}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: { [supportedField]: status }
  })
}

async function getStatusCollectionItemByField(collection, field, status, token) {
  const params = new URLSearchParams()
  params.append(field, status)
  params.append('_limit', '1')

  try {
    const existing = await $fetch(`${config.strapiUrl}/${collection}?${params.toString()}`, {
      headers: { Authorization: `Bearer ${token}` }
    })
    return {
      supported: true,
      item: Array.isArray(existing) ? existing[0] : existing
    }
  } catch (error) {
    const message = error?.data?.message || error?.message || ''
    const statusCode = error?.response?.status || error?.statusCode || error?.status
    if (statusCode === 400 && message.includes(`field '${field}'`)) {
      return { supported: false, item: null }
    }
    throw error
  }
}

async function getCartStatus(name) {
  return await getOrCreateStatusCollectionItem('cart-statuses', name)
}

async function getOrderStatus(name) {
  return await getOrCreateStatusCollectionItem('order-statuses', name)
}

async function resolveCheckoutDomainId(domainName) {
  if (!domainName) return null
  const token = await getStrapiAdminToken()
  const host = String(domainName).replace(/^https?:\/\//, '').replace(/\/.*$/, '')
  const params = new URLSearchParams()
  params.append('_limit', '1')
  params.append('_where[_or][0][url_contains]', host)
  params.append('_where[_or][1][name_contains]', host)

  try {
    const domains = await $fetch(`${config.strapiUrl}/domains?${params.toString()}`, {
      headers: { Authorization: `Bearer ${token}` }
    })
    return Array.isArray(domains) && domains[0] ? domains[0].id : null
  } catch (error) {
    console.warn('checkout domain resolve failed', error.message) // eslint-disable-line no-console
    return null
  }
}

export { checkoutTimeoutSeconds, checkoutCartExpiry, checkoutCartExpired } from './cartExpiry.js'
import { checkoutCartExpiry, checkoutCartExpired } from './cartExpiry.js'

function checkoutCartProductIds(cart) {
  return (cart?.cartProducts || []).map(item => item.product?.id || item.product).filter(Boolean)
}

async function releaseCheckoutCartReservations(cart) {
  const userId = cart?.users_permissions_user?.id || cart?.users_permissions_user || null
  await Promise.all(checkoutCartProductIds(cart).map(productId => clearCheckoutProductReservation(productId, userId).catch(() => null)))
}

async function refreshCheckoutCartReservations(cart, userId) {
  await Promise.all((cart?.cartProducts || []).map(item => {
    const productId = item.product?.id || item.product
    if (!productId) return null
    return refreshCheckoutProductReservation(productId, userId, item.priceInCart).catch(() => null)
  }))
}

async function markCheckoutCartExpired(cart) {
  if (!cart?.id) return
  const token = await getStrapiAdminToken()
  const expiredStatus = await getCartStatus('expired')
  await $fetch(`${config.strapiUrl}/carts/${cart.id}`, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: {
      cart_status: expiredStatus.id,
      cartUpdatedAt: new Date().toISOString()
    }
  }).catch(() => null)
}

async function expireCheckoutCart(cart) {
  if (!cart) return
  await releaseCheckoutCartReservations(cart)
  await markCheckoutCartExpired(cart)
}

export async function getCleanupState() {
  const token = await getStrapiAdminToken()
  return await $fetch(`${config.strapiUrl}/cleanup-state`, {
    headers: { Authorization: `Bearer ${token}` }
  }).catch(() => null)
}

export async function saveCleanupState(data) {
  const token = await getStrapiAdminToken()
  return await $fetch(`${config.strapiUrl}/cleanup-state`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: data
  }).catch(() => null)
}

export async function runStartupCartRecovery() {
  const token = await getStrapiAdminToken()
  const activeStatus = await getCartStatus('active')
  const params = new URLSearchParams()
  params.append('cart_status', activeStatus.id)
  params.append('_limit', '-1')

  const carts = await $fetch(`${config.strapiUrl}/carts?${params.toString()}`, {
    headers: { Authorization: `Bearer ${token}` }
  }).catch(() => [])

  const now = new Date().toISOString()
  await Promise.all((Array.isArray(carts) ? carts : []).map(cart =>
    $fetch(`${config.strapiUrl}/carts/${cart.id}`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: { cartUpdatedAt: now }
    }).catch(() => null)
  ))

  return (Array.isArray(carts) ? carts : []).length
}

export async function expireStaleCheckoutCarts() {
  const token = await getStrapiAdminToken()
  const activeStatus = await getCartStatus('active')
  const params = new URLSearchParams()
  params.append('cart_status', activeStatus.id)
  params.append('_limit', '-1')
  params.append('_sort', 'cartUpdatedAt:ASC')

  const carts = await $fetch(`${config.strapiUrl}/carts?${params.toString()}`, {
    headers: { Authorization: `Bearer ${token}` }
  }).catch(() => [])

  const staleCarts = (Array.isArray(carts) ? carts : []).filter(checkoutCartExpired)
  await Promise.all(staleCarts.map(cart => expireCheckoutCart(cart)))
  return { checked: carts.length, expired: staleCarts.length }
}

async function getCurrentCheckoutCart(userId, options = {}) {
  if (!userId) return null
  await expireStaleCheckoutCarts()
  const token = await getStrapiAdminToken()
  const activeStatus = await getCartStatus(options.status || 'active')
  const params = new URLSearchParams()
  params.append('users_permissions_user', userId)
  params.append('cart_status', activeStatus.id)
  params.append('_sort', 'cartUpdatedAt:DESC')
  params.append('_limit', '1')

  const carts = await $fetch(`${config.strapiUrl}/carts?${params.toString()}`, {
    headers: { Authorization: `Bearer ${token}` }
  })
  const cart = Array.isArray(carts) ? carts[0] : carts
  if (cart && checkoutCartExpired(cart)) {
    await expireCheckoutCart(cart)
    return null
  }
  return cart
}

async function ensureCurrentCheckoutCart(userId, body = {}) {
  const token = await getStrapiAdminToken()
  const existing = await getCurrentCheckoutCart(userId)
  if (existing) return existing

  const activeStatus = await getCartStatus('active')
  const now = new Date().toISOString()
  const domainId = await resolveCheckoutDomainId(body.domain)
  return await $fetch(`${config.strapiUrl}/carts`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: {
      users_permissions_user: userId,
      domain: domainId,
      locale: body.locale || 'et',
      cartProducts: [],
      cartTimeout: '00:30:00',
      cartCreatedAt: now,
      cartUpdatedAt: now,
      cart_status: activeStatus.id
    }
  })
}

function isNumericId(value) {
  return /^\d+$/.test(String(value || ''))
}

async function getProductCategoryByAnyId(categoryId, codePrefix) {
  const token = await getStrapiAdminToken()
  if (isNumericId(categoryId)) return await getStrapiCollectionItem('product-categories', categoryId)

  const params = new URLSearchParams()
  params.append('_limit', '1')
  params.append('codePrefix', codePrefix || categoryId)
  const categories = await $fetch(`${config.strapiUrl}/product-categories?${params.toString()}`, {
    headers: { Authorization: `Bearer ${token}` }
  })
  return Array.isArray(categories) ? categories[0] : categories
}

async function getAvailableCheckoutProducts(category, limit = 1, excludedProductIds = []) {
  await expireStaleCheckoutCarts()
  const token = await getStrapiAdminToken()
  const params = new URLSearchParams()
  params.append('_limit', String(Math.max(limit + excludedProductIds.length + 5, 10)))
  params.append('code_null', 'false')
  params.append('reserved_to_null', 'true')
  params.append('owner_null', 'true')
  params.append('product_category_null', 'false')
  params.append('transactions_null', 'true')
  params.append('active', 'true')
  if (category?.id) params.append('product_category', category.id)
  else if (category?.codePrefix) params.append('product_category.codePrefix', category.codePrefix)

  const products = await $fetch(`${config.strapiUrl}/products?${params.toString()}`, {
    headers: { Authorization: `Bearer ${token}` }
  })
  const excluded = new Set(excludedProductIds.map(id => String(id)))
  return (Array.isArray(products) ? products : [products]).filter(product => product && !excluded.has(String(product.id))).slice(0, limit)
}

function checkoutCategoryTitle(category, locale = 'et') {
  if (!category) return ''
  if (category.name && typeof category.name === 'object') return category.name[locale] || category.name.et || category.name.en || category.name.ru || ''
  return category[`name_${locale}`] || category.name_et || category.name_en || category.namePrivate || ''
}

function checkoutLocalizedText(value, locale = 'et') {
  if (!value) return ''
  if (typeof value === 'object') return value[locale] || value.et || value.en || value.ru || ''
  return value
}

function checkoutPublicStrapiUrl() {
  return String(config.strapiUrl || '').replace('host.docker.internal', 'localhost').replace(/\/$/, '')
}

function checkoutMediaUrl(media) {
  const file = Array.isArray(media) ? media[0] : media
  if (!file) return ''
  if (file.url && /^https?:\/\//.test(file.url)) return file.url
  if (file.url && file.url.startsWith('/') && checkoutPublicStrapiUrl()) return `${checkoutPublicStrapiUrl()}${file.url}`
  if (file.hash && file.ext) return `https://assets.poff.ee/img/${file.hash}${file.ext}`
  return ''
}

function checkoutCategoryImageUrl(category, locale = 'et') {
  const images = category?.images || {}
  return checkoutMediaUrl(
    images[`image_${locale}`] ||
    images.image ||
    images.imageDefault ||
    images.image_en ||
    images.image_et ||
    images.image_ru
  )
}

function normalizeCheckoutLocation(location, locale = 'et') {
  if (!location) return null
  const name = checkoutLocalizedText(location.name, locale) || location.name_et || location.name_en || ''
  const hall = checkoutLocalizedText(location.hall, locale)
  const city = checkoutLocalizedText(location.city, locale)
  return {
    id: location.id,
    name: [name, hall, city].filter(Boolean).join(', '),
    raw: location
  }
}

function normalizeCheckoutMethodGroup(paymentMethods = {}) {
  return [
    ...(paymentMethods.banklinks || []),
    ...(paymentMethods.cards || []),
    ...(paymentMethods.other || []),
    ...(paymentMethods.payLater || [])
  ].filter(Boolean)
}

async function serializeCheckoutCart(cart, locale = 'et') {
  if (!cart) return null
  const products = cart.cartProducts || []
  const items = []
  const expiry = checkoutCartExpiry(cart)

  for (let index = 0; index < products.length; index++) {
    const row = products[index]
    const product = row.product && typeof row.product === 'object' ? row.product : await getStrapiCollectionItem('products', row.product)
    if (!product) continue
    const category = product.product_category && typeof product.product_category === 'object'
      ? product.product_category
      : await getStrapiCollectionItem('product-categories', product.product_category)
    const price = Number(row.priceInCart || getCheckoutProductCurrentPrice(category) || 0)
    items.push({
      index,
      componentId: row.id,
      productId: product.id,
      productCode: product.code,
      categoryId: category?.id,
      codePrefix: category?.codePrefix,
      title: checkoutCategoryTitle(category, locale),
      imageUrl: checkoutCategoryImageUrl(category, locale),
      price,
      transferable: product.transferable === true || category?.transferable === true,
      pickupLocations: (category?.pickup_locations || []).map(location => normalizeCheckoutLocation(location, locale)).filter(Boolean),
      sellerBusinessProfileId: category?.business_profile?.id || category?.business_profile || null,
      timeToCart: row.timeToCart || null
    })
  }

  return {
    id: cart.id,
    locale: cart.locale || locale,
    status: cart.cart_status?.status || cart.cart_status?.name || cart.cart_status || null,
    timeoutSeconds: expiry.timeoutSeconds,
    secondsRemaining: expiry.secondsRemaining,
    expiresAt: expiry.expiresAt,
    serverNow: new Date().toISOString(),
    total: items.reduce((sum, item) => sum + Number(item.price || 0), 0),
    items
  }
}

export async function getCheckoutCart(userId, locale = 'et') {
  const cart = await getCurrentCheckoutCart(userId)
  return await serializeCheckoutCart(cart, locale)
}

// How many more products of a category this user can still add to their cart
// (in stock, not owned/reserved/transacted, and not already in their cart).
// Used by the shop to disable "Add to cart" / "Add another" up front.
export async function getCheckoutCategoryAvailability(userId, categoryId, codePrefix) {
  const category = await getProductCategoryByAnyId(categoryId || codePrefix, codePrefix)
  if (!category?.id) return { code: 400, case: 'noCategoryId', availableCount: 0 }
  const cart = userId ? await getCurrentCheckoutCart(userId) : null
  const existingProductIds = (cart?.cartProducts || []).map(item => item.product?.id || item.product).filter(Boolean)
  const products = await getAvailableCheckoutProducts(category, 50, existingProductIds)
  return { availableCount: products.length }
}

export async function addCheckoutCartItem(userId, body = {}) {
  if (!userId) return { code: 401, case: 'unauthorized' }

  const quantity = Math.max(1, Math.min(20, Number(body.quantity || 1)))
  const category = await getProductCategoryByAnyId(body.categoryId || body.codePrefix, body.codePrefix)
  if (!category?.id) return { code: 400, case: 'noCategoryId' }
  const price = getCheckoutProductCurrentPrice(category)
  if (price === undefined || price === null || Number.isNaN(Number(price))) return { code: 400, case: 'noCurrentPrice' }

  const cart = await ensureCurrentCheckoutCart(userId, body)
  const existingProductIds = (cart.cartProducts || []).map(item => item.product?.id || item.product).filter(Boolean)
  const products = await getAvailableCheckoutProducts(category, quantity, existingProductIds)
  if (products.length < quantity) return { code: 404, case: 'noItems', available: products.length }

  const token = await getStrapiAdminToken()
  const now = new Date().toISOString()
  const reservedProductIds = []
  const newRows = products.map(product => ({
    product: product.id,
    priceInCart: price,
    timeToCart: now
  }))

  try {
    for (const product of products) {
      const reserved = await refreshCheckoutProductReservation(product.id, userId, price)
      if (!reserved?.reserved_to) throw new Error('reservationSaveFailed')
      reservedProductIds.push(product.id)
    }
    await refreshCheckoutCartReservations(cart, userId)

    const updated = await $fetch(`${config.strapiUrl}/carts/${cart.id}`, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: {
        cartProducts: [...(cart.cartProducts || []).map(item => ({
          id: item.id,
          product: item.product?.id || item.product,
          priceInCart: item.priceInCart,
          timeToCart: item.timeToCart
        })), ...newRows],
        cartUpdatedAt: now
      }
    })

    return await serializeCheckoutCart(updated, body.locale || cart.locale || 'et')
  } catch (error) {
    await Promise.all(reservedProductIds.map(productId => clearCheckoutProductReservation(productId, userId).catch(() => null)))
    return { code: 409, case: error.message === 'reservationSaveFailed' ? 'reservationSaveFailed' : 'productUnavailable' }
  }
}

export async function removeCheckoutCartItem(userId, body = {}) {
  if (!userId) return { code: 401, case: 'unauthorized' }
  const cart = await getCurrentCheckoutCart(userId)
  if (!cart) return { code: 404, case: 'noCart' }

  const token = await getStrapiAdminToken()
  const removeIndex = Number(body.index)
  const removeProductId = body.productId ? String(body.productId) : null
  let removed = false
  const removedProductIds = []
  const rows = (cart.cartProducts || []).filter((item, index) => {
    if (!removed && Number.isInteger(removeIndex) && index === removeIndex) {
      removed = true
      removedProductIds.push(item.product?.id || item.product)
      return false
    }
    if (!removed && removeProductId && String(item.product?.id || item.product) === removeProductId) {
      removed = true
      removedProductIds.push(item.product?.id || item.product)
      return false
    }
    return true
  }).map(item => ({
    id: item.id,
    product: item.product?.id || item.product,
    priceInCart: item.priceInCart,
    timeToCart: item.timeToCart
  }))

  await Promise.all(removedProductIds.map(productId => clearCheckoutProductReservation(productId, userId).catch(() => null)))
  await refreshCheckoutCartReservations({ ...cart, cartProducts: rows }, userId)

  const updated = await $fetch(`${config.strapiUrl}/carts/${cart.id}`, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: {
      cartProducts: rows,
      cartUpdatedAt: new Date().toISOString()
    }
  })
  return await serializeCheckoutCart(updated, body.locale || cart.locale || 'et')
}

export async function clearCheckoutCart(userId) {
  if (!userId) return { code: 401, case: 'unauthorized' }
  const cart = await getCurrentCheckoutCart(userId)
  if (!cart) return { ok: true }
  const token = await getStrapiAdminToken()
  await releaseCheckoutCartReservations(cart)
  const updated = await $fetch(`${config.strapiUrl}/carts/${cart.id}`, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: {
      cartProducts: [],
      cartUpdatedAt: new Date().toISOString()
    }
  })
  return await serializeCheckoutCart(updated, cart.locale || 'et')
}

export async function touchCheckoutCartSession(userId, locale = 'et') {
  if (!userId) return { code: 401, case: 'unauthorized' }
  const cart = await getCurrentCheckoutCart(userId)
  if (!cart) return { items: [], total: 0 }
  const token = await getStrapiAdminToken()
  const now = new Date().toISOString()

  await refreshCheckoutCartReservations(cart, userId)

  const updated = await $fetch(`${config.strapiUrl}/carts/${cart.id}`, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: {
      cartUpdatedAt: now
    }
  })
  return await serializeCheckoutCart(updated, locale || cart.locale || 'et')
}

export async function getCheckoutContext(userId, locale = 'et') {
  if (!userId) return { code: 401, case: 'unauthorized' }
  const user = await getStrapiUser(userId)
  const cart = await getCheckoutCart(userId, locale)
  const token = await getStrapiAdminToken()
  const params = new URLSearchParams()
  params.append('_where[user]', userId)
  params.append('_where[saved_for_reuse_ne]', false)
  const businessProfiles = await $fetch(`${config.strapiUrl}/business-profiles?${params.toString()}`, {
    headers: { Authorization: `Bearer ${token}` }
  })
  const paymentMethods = await getPaymentMethods()
  return {
    user,
    profile: user?.user_profile || null,
    cart,
    businessProfiles,
    paymentMethods
  }
}

async function createCartMaksekeskusTransaction({ body, userEmail, userId, billingProfileId, orderId, cartId, orderProducts, amount }) {
  const host = String(config.maksekeskusHost || 'https://api.test.maksekeskus.ee').replace(/\/$/, '')
  const mkUrl = host.startsWith('http') ? `${host}/v1/transactions` : `https://${host}/v1/transactions`
  const mkId = config.maksekeskusId
  const mkSecret = config.maksekeskusSecret

  const postData = {
    customer: {
      email: userEmail,
      ip: body.ip || '',
      country: 'ee',
      locale: body.locale || 'et'
    },
    transaction: {
      amount,
      currency: 'EUR',
      merchant_data: JSON.stringify({
        checkoutType: 'cart',
        userId,
        cartId,
        orderId,
        locale: body.locale || 'et',
        selectedBillingProfileId: billingProfileId,
        products: orderProducts,
        cancel_url: body.cancel_url,
        return_url: body.return_url
      }),
      reference: `order-${orderId}`,
      transaction_url: {
        cancel_url: { method: 'POST', url: `${config.strapiUrl}/users-permissions/users/buyproductcb/cancel` },
        notification_url: { method: 'POST', url: `${config.strapiUrl}/users-permissions/users/buyproductcb/notification` },
        return_url: { method: 'POST', url: `${config.strapiUrl}/users-permissions/users/buyproductcb/return` }
      }
    }
  }

  try {
    const response = await $fetch(mkUrl, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${Buffer.from(`${mkId}:${mkSecret}`).toString('base64')}`,
        'Content-Type': 'application/json'
      },
      body: postData
    })
    return response
  } catch (error) {
    throw error
  }
}

export async function payCheckoutCart(userId, body = {}) {
  if (!userId) return { code: 401, case: 'unauthorized' }
  if (!body.paymentMethodId) return { code: 400, case: 'noPaymentMethodId' }

  const cart = await getCurrentCheckoutCart(userId)
  const cartData = await serializeCheckoutCart(cart, body.locale || 'et')
  if (!cartData?.items?.length) return { code: 400, case: 'emptyCart' }

  const billingProfileId = await validateCheckoutBusinessProfile(userId, body.billingProfileId || body.buyerBusinessProfileId)
  if (!billingProfileId) return { code: 400, case: 'invalidBillingProfile' }

  const buyer = await getStrapiUser(userId)
  const buyerProfile = buyer.user_profile || {}
  if (!hasCompleteCheckoutBuyerProfile(buyerProfile)) {
    return { code: 400, case: 'buyerProfileIncomplete', missing: missingBuyerProfileFields(buyerProfile) }
  }

  const itemPayload = Array.isArray(body.items) ? body.items : []
  const token = await getStrapiAdminToken()
  const reservedProductIds = []
  const orderProducts = []
  const componentRows = []
  const now = new Date().toISOString()
  let createdOrderId = null
  let cartMovedToCheckout = false
  const checkoutError = result => {
    const error = new Error(result.case || 'checkoutError')
    error.checkoutResult = result
    return error
  }

  try {
    for (const cartItem of cartData.items) {
      const submitted = itemPayload.find(item => String(item.productId) === String(cartItem.productId) || Number(item.index) === Number(cartItem.index)) || {}
      const category = await getStrapiCollectionItem('product-categories', cartItem.categoryId)
      const deliveryLocationId = validateCheckoutDeliveryLocation(category.pickup_locations || [], submitted.pickupLocationId)
      if (deliveryLocationId === false) throw checkoutError({ code: 400, case: submitted.pickupLocationId ? 'invalidDeliveryLocation' : 'noDeliveryLocation', productId: cartItem.productId })

      const ownerResult = await resolveCheckoutOwner(userId, category, submitted.owner || { mode: 'me' })
      if (ownerResult.error) throw checkoutError({ code: 400, case: ownerResult.error, missing: ownerResult.missing, productId: cartItem.productId })

      const reserved = await reserveCheckoutProduct(cartItem.productId, userId, cartItem.price)
      if (!reserved?.reserved_to) throw checkoutError({ code: 409, case: 'productUnavailable', productId: cartItem.productId })
      reservedProductIds.push(cartItem.productId)

      componentRows.push({
        product: cartItem.productId,
        priceInCart: cartItem.price,
        timeToCart: cartItem.timeToCart || now,
        pickupLocation: deliveryLocationId || null,
        owner: ownerResult.userId
      })
      orderProducts.push({
        productId: cartItem.productId,
        categoryId: cartItem.codePrefix,
        productCategoryId: cartItem.categoryId,
        productCatSeller: cartItem.sellerBusinessProfileId,
        deliveryLocationId: deliveryLocationId || null,
        ownerUserId: ownerResult.userId,
        ownerMode: ownerResult.mode,
        ownerSendEmail: ownerResult.sendEmail === true,
        price: cartItem.price
      })
    }

    const pendingStatus = await getOrderStatus('pending_payment')
    const checkoutStatus = await getCartStatus('checkout_started')
    const amount = cartData.items.reduce((sum, item) => sum + Number(item.price || 0), 0)
    const domainId = cart?.domain?.id || cart?.domain || null
    const order = await $fetch(`${config.strapiUrl}/orders`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: {
        users_permissions_user: userId,
        domain: domainId,
        orderTimeout: '00:30:00',
        orderCreatedAt: now,
        orderUpdatedAt: now,
        orderProducts: componentRows,
        order_status: pendingStatus.id,
        orderSum: amount,
        buyerBusinessProfile: billingProfileId
      }
    })
    createdOrderId = order.id

    await $fetch(`${config.strapiUrl}/carts/${cart.id}`, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: {
        cart_status: checkoutStatus.id,
        cartUpdatedAt: now
      }
    })
    cartMovedToCheckout = true

    const mkResponse = await createCartMaksekeskusTransaction({
      body,
      userId,
      userEmail: buyerProfile.email || buyer.email,
      billingProfileId,
      orderId: order.id,
      cartId: cart.id,
      orderProducts,
      amount
    })

    const paymentMethod = normalizeCheckoutMethodGroup({
      banklinks: mkResponse.payment_methods?.banklinks,
      cards: mkResponse.payment_methods?.cards,
      other: mkResponse.payment_methods?.other,
      payLater: mkResponse.payment_methods?.payLater
    }).find(method => buildMaksekeskusMethodId(method) === body.paymentMethodId)

    if (!paymentMethod) throw checkoutError({ code: 400, case: 'noPaymentMethod' })

    return { url: paymentMethod.url, orderId: order.id }
  } catch (error) {
    if (reservedProductIds.length) await refreshCheckoutCartReservations(cart, userId)
    if (cartMovedToCheckout && cart?.id) {
      const activeStatus = await getCartStatus('active').catch(() => null)
      if (activeStatus?.id) {
        await $fetch(`${config.strapiUrl}/carts/${cart.id}`, {
          method: 'PUT',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json'
          },
          body: {
            cart_status: activeStatus.id,
            cartUpdatedAt: new Date().toISOString()
          }
        }).catch(() => null)
      }
    }
    if (createdOrderId) {
      const failedStatus = await getOrderStatus('payment_failed').catch(() => null)
      if (failedStatus?.id) {
        await $fetch(`${config.strapiUrl}/orders/${createdOrderId}`, {
          method: 'PUT',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json'
          },
          body: {
            order_status: failedStatus.id,
            orderUpdatedAt: new Date().toISOString()
          }
        }).catch(() => null)
      }
    }
    if (error.checkoutResult) return error.checkoutResult
    throw error
  }
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
