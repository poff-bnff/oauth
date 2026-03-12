export default defineEventHandler(async (event) => {
  const q = getQuery(event)
  const courseEventId = parseInt(Object.keys(q)[0])

  const userId = getUserIdFromEvent(event)
  if (!userId) {
    throw createError({ statusCode: 401, statusMessage: 'Unauthorized' })
  }

  // Fetch user with populated user_roles and nested relations
  const config = useRuntimeConfig()
  const token = await getStrapiToken()
  
  const populateQuery = 'populate[user_roles][populate][0]=user_right.functions.function_parameters'
  const user = await $fetch(`${config.strapiUrl}/users/${userId}?${populateQuery}`, {
    headers: { Authorization: `Bearer ${token}` }
  })

  if (!user) {
    throw createError({ statusCode: 404, statusMessage: 'User not found' })
  }

  // Check for show_courseevent_video permission
  const currentDate = new Date()
  let hasPermission = false

  if (user.user_roles && Array.isArray(user.user_roles)) {
    // Filter roles that are currently valid
    const validRoles = user.user_roles.filter(role => {
      const validFrom = role.valid_from ? new Date(role.valid_from) : null
      const validTo = role.valid_to ? new Date(role.valid_to) : null
      
      const isValidFrom = !validFrom || validFrom <= currentDate
      const isValidTo = !validTo || validTo >= currentDate
      
      return isValidFrom && isValidTo
    })

    // Check if any valid role has the show_courseevent_video permission
    for (const role of validRoles) {
      if (!role.user_right || !Array.isArray(role.user_right)) continue

      for (const right of role.user_right) {
        if (!right.functions || !Array.isArray(right.functions)) continue

        for (const func of right.functions) {
          if (!func.function_parameters || !Array.isArray(func.function_parameters)) continue

          const hasVideoPermission = func.function_parameters.some(param => 
            param.property === 'show_courseevent_video' && param.value === 'true'
          )

          if (hasVideoPermission) {
            hasPermission = true
            break
          }
        }

        if (hasPermission) break
      }

      if (hasPermission) break
    }
  }

  // Log the permission check result
  console.log(`Video access for user ${userId}, course-event ${courseEventId}: ${hasPermission ? 'GRANTED' : 'DENIED'}`) // eslint-disable-line no-console

  // If permission denied, return error
  if (!hasPermission) {
    return {
      error: 'No permission to view video',
      code: 403
    }
  }

  // Permission granted - fetch course-event and parse video URL
  const videoUrl = await readCourseEventVideolevelsUrl(courseEventId)

  if (!videoUrl) {
    return {
      error: 'Video URL not found',
      code: 404
    }
  }

  try {
    // Parse video URL: https://videolevels.com/bc/VIDEO_ID/something
    const videoProvider = videoUrl.split('/')[2]
    const videoId = videoUrl.split('/bc/')[1].split('/')[0]
    
    return {
      videoProvider,
      videoId
    }
  } catch (error) {
    console.error(`Failed to parse video URL for course-event ${courseEventId}: ${videoUrl}`, error) // eslint-disable-line no-console
    return {
      error: 'Failed to parse video URL',
      code: 500
    }
  }
})
