import { getStrapiAdminToken, getStrapiToken } from '../../utils/strapi.js'
import {
  ALLOWED_CONTENT_TYPES,
  hasVideoPermission,
  parseVideoUrl,
  pickVideoUrl,
  userFunctionIds,
  videoContentPath
} from '../../utils/videoAccess.js'

// Fetch the raw video URL of the given content type and id from Strapi, or null.
// The admin token is used because the Hunt role may read only course-event by id.
async function fetchVideoUrl (contentType, contentId) {
  const config = useRuntimeConfig()
  const token = await getStrapiAdminToken()

  const record = await $fetch(`${config.strapiUrl}${videoContentPath(contentType)}/${contentId}`, {
    headers: { Authorization: `Bearer ${token}` }
  })
  return pickVideoUrl(contentType, record)
}

// Does the user hold, through a currently valid role, a function with show_courseevent_video = true?
// Strapi 3 returns the functions nested in the user WITHOUT their function_parameters, so the functions
// the user holds are read separately from /functions (admin token: the Hunt role may not read functions).
async function userMayWatchVideo (user) {
  const functionIds = userFunctionIds(user)
  if (!functionIds.length) return false

  const config = useRuntimeConfig()
  const token = await getStrapiAdminToken()

  const functions = await $fetch(`${config.strapiUrl}/functions?${functionIds.map(id => `id_in=${id}`).join('&')}`, {
    headers: { Authorization: `Bearer ${token}` }
  })
  return hasVideoPermission(user, functions)
}

export default defineEventHandler(async (event) => {
  const q = getQuery(event)

  // Support both new format (?contentType=course-event&contentId=123)
  // and old deployed format (?123) for backward compatibility.
  const legacyContentIdKey = Object.keys(q).find(key => /^\d+$/.test(key))
  const contentType = ALLOWED_CONTENT_TYPES.includes(q.contentType)
    ? q.contentType
    : 'course-event'
  const contentId = q.contentId
    ? parseInt(q.contentId, 10)
    : legacyContentIdKey !== undefined
      ? parseInt(legacyContentIdKey, 10)
      : NaN

  if (!contentId || isNaN(contentId)) {
    throw createError({ statusCode: 400, statusMessage: 'Missing or invalid contentId' })
  }

  if (q.contentType && !ALLOWED_CONTENT_TYPES.includes(q.contentType)) {
    throw createError({ statusCode: 400, statusMessage: 'Invalid contentType' })
  }

  const userId = getUserIdFromEvent(event)
  if (!userId) {
    throw createError({ statusCode: 401, statusMessage: 'Unauthorized' })
  }

  const config = useRuntimeConfig()
  const token = await getStrapiToken()

  const user = await $fetch(`${config.strapiUrl}/users/${userId}`, {
    headers: { Authorization: `Bearer ${token}` }
  })

  if (!user) {
    throw createError({ statusCode: 404, statusMessage: 'User not found' })
  }

  const permitted = await userMayWatchVideo(user)
  console.log(`Video access for user ${userId}, ${contentType} ${contentId}: ${permitted ? 'GRANTED' : 'DENIED'}`) // eslint-disable-line no-console

  if (!permitted) {
    return { error: 'No permission to view video', code: 403 }
  }

  const videoUrl = await fetchVideoUrl(contentType, contentId)

  if (!videoUrl) {
    return { error: 'Video URL not found', code: 404 }
  }

  const parsed = parseVideoUrl(videoUrl)
  if (!parsed) {
    console.error(`Failed to parse video URL for ${contentType} ${contentId}: ${videoUrl}`) // eslint-disable-line no-console
    return { error: 'Failed to parse video URL', code: 500 }
  }

  return parsed
})
