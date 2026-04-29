import { getStrapiToken } from '../../utils/strapi.js'

const ALLOWED_CONTENT_TYPES = ['course-event', 'dis-camp-event', 'industry-project']

// Fetch video URL from Strapi for the given content type and ID.
// Returns a raw URL string or null.
async function fetchVideoUrl (contentType, contentId) {
  const config = useRuntimeConfig()
  const token = await getStrapiToken()

  const fetch = (path) => $fetch(`${config.strapiUrl}${path}`, {
    headers: { Authorization: `Bearer ${token}` }
  })

  switch (contentType) {
    case 'course-event': {
      const record = await fetch(`/course-events/${contentId}`)
      return record?.video_url || null
    }
    case 'dis-camp-event': {
      const record = await fetch(`/dis-camp-events/${contentId}`)
      return record?.video_url || null
    }
    case 'industry-project': {
      const record = await fetch(`/industry-projects/${contentId}`)
      return record?.clipUrl || null
    }
    default:
      return null
  }
}

// Parse a raw video URL into { videoProvider, videoId }.
// Supports videolevels.com (/bc/ format), Vimeo, and YouTube.
function parseVideoUrl (videoUrl) {
  if (!videoUrl) return null

  try {
    if (videoUrl.includes('videolevels.com')) {
      const parsedUrl = new URL(videoUrl)
      const videoProvider = parsedUrl.hostname.replace(/^www\./, '')
      if (videoProvider !== 'videolevels.com') return null

      const pathMatch = parsedUrl.pathname.match(/^\/bc\/([^/]+)/)
      const videoId = pathMatch ? pathMatch[1] : null

      return videoId ? { videoProvider, videoId } : null
    }

    if (videoUrl.includes('vimeo.com')) {
      let videoId = null
      const vimeoMatch = videoUrl.match(/(?:vimeo\.com\/(?:.*\/)?|player\.vimeo\.com\/video\/)(\d+)(?:$|[/?#])/)
      if (vimeoMatch) videoId = vimeoMatch[1]
      return videoId ? { videoProvider: 'vimeo', videoId } : null
    }

    if (videoUrl.includes('youtube.com') || videoUrl.includes('youtu.be')) {
      let videoId = null
      const ytMatch = videoUrl.match(/(?:v=|\/embed\/|youtu\.be\/)([a-zA-Z0-9_-]{11})/)
      if (ytMatch) videoId = ytMatch[1]
      return videoId ? { videoProvider: 'youtube', videoId } : null
    }
  } catch {
    return null
  }

  return null
}

// Check whether a Strapi user (with populated user_roles) has the show_courseevent_video permission
// in at least one currently valid role.
function hasVideoPermission (user) {
  if (!Array.isArray(user.user_roles)) return false

  const now = new Date()

  for (const role of user.user_roles) {
    const validFrom = role.valid_from ? new Date(role.valid_from) : null
    const validTo = role.valid_to ? new Date(role.valid_to) : null
    if (validFrom && validFrom > now) continue
    if (validTo && validTo < now) continue

    for (const right of (role.user_right || [])) {
      for (const func of (right.functions || [])) {
        const allowed = (func.function_parameters || []).some(
          p => p.property === 'show_courseevent_video' && p.value === 'true'
        )
        if (allowed) return true
      }
    }
  }

  return false
}

export default defineEventHandler(async (event) => {
  const q = getQuery(event)

  // Support both new format (?contentType=course-event&contentId=123)
  // and old deployed format (?123) for backward compatibility.
  const legacyContentIdKey = Object.keys(q).find(key => /^\d+$/.test(key))
  const contentType = ALLOWED_CONTENT_TYPES.includes(q.contentType) ? q.contentType : 'course-event'
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

  const populateQuery = 'populate[user_roles][populate][0]=user_right.functions.function_parameters'
  const user = await $fetch(`${config.strapiUrl}/users/${userId}?${populateQuery}`, {
    headers: { Authorization: `Bearer ${token}` }
  })

  if (!user) {
    throw createError({ statusCode: 404, statusMessage: 'User not found' })
  }

  const permitted = hasVideoPermission(user)
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

