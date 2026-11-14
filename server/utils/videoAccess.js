// Pure helpers for GET /api/validate/eventUrl (restricted course-event / industry video).
//
// Why this exists: live Strapi 3.6.10 returns the user's rights only one level deep. In
// GET /users/:id the functions inside user_roles[].user_right[].functions[] arrive WITHOUT their
// function_parameters, so the parameters have to be read from GET /functions and joined by id.

// The parameter a Strapi Function must carry (value "true") to unlock the restricted videos.
export const PERMISSION_PROPERTY = 'show_courseevent_video'

// Which Strapi collection and which field hold the video of each content type.
const CONTENT = {
  'course-event': { path: '/course-events', field: 'video_url' },
  'dis-camp-event': { path: '/dis-camp-events', field: 'videoUrl' },
  'industry-event': { path: '/industry-events', field: 'videoUrl' },
  'industry-project': { path: '/industry-projects', field: 'clipUrl' }
}

export const ALLOWED_CONTENT_TYPES = Object.keys(CONTENT)

export const videoContentPath = contentType => CONTENT[contentType]?.path

export function pickVideoUrl (contentType, record) {
  const field = CONTENT[contentType]?.field
  return (field && record?.[field]) || null
}

// Parse a raw video URL into { videoProvider, videoId }.
// Supports videolevels.com (/bc/<id> and /landing/bc/<id>), Vimeo and YouTube.
export function parseVideoUrl (videoUrl) {
  if (!videoUrl) return null

  try {
    if (videoUrl.includes('videolevels.com')) {
      const parsedUrl = new URL(videoUrl)
      const videoProvider = parsedUrl.hostname.replace(/^www\./, '')
      if (videoProvider !== 'videolevels.com') return null

      const pathMatch = parsedUrl.pathname.match(/\/bc\/([^/]+)/)
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

// Roles that are valid right now. A missing valid_from / valid_to leaves that side open.
function currentRoles (user) {
  if (!Array.isArray(user?.user_roles)) return []

  const now = new Date()
  return user.user_roles.filter((role) => {
    const validFrom = role.valid_from ? new Date(role.valid_from) : null
    const validTo = role.valid_to ? new Date(role.valid_to) : null
    return !(validFrom && validFrom > now) && !(validTo && validTo < now)
  })
}

// Ids of every function the user holds through a currently valid role.
export function userFunctionIds (user) {
  const ids = new Set()
  for (const role of currentRoles(user)) {
    for (const right of (role.user_right || [])) {
      for (const func of (right.functions || [])) ids.add(func.id)
    }
  }
  return [...ids]
}

// `functions` are the entries from GET /functions (with function_parameters), not the ones nested in the user.
export function hasVideoPermission (user, functions) {
  const held = new Set(userFunctionIds(user))
  return (Array.isArray(functions) ? functions : []).some(func =>
    held.has(func.id) &&
    (func.function_parameters || []).some(p =>
      p.property === PERMISSION_PROPERTY && String(p.value).trim().toLowerCase() === 'true'))
}
