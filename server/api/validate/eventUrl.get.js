export default defineEventHandler(async (event) => {
  const q = getQuery(event)
  const courseEventId = parseInt(Object.keys(q)[0])

  const id = getUserIdFromEvent(event)
  const user = await getStrapiUser(id)
  if (!user) throw createError({ statusCode: 404, statusMessage: 'Not Found' })

  // Fetches and consolidates all user badges, including all statuses for each badge name
  await loadFionaBadges(user)

  const WHITELIST = [
    'Management',
    'Jury',
    'VIP',
    'Team',
    'Press',
    'Volunteer Green',
    'Volunteer Blue',
    'Industry@Tallinn & Baltic Event / Student Talent',
    'Industry@Tallinn & Baltic Event / PRO',
    'Intern'
  ]

  const ALLOWED_STATUSES = [
    'Approved',
    'Delivered',
    'Paid',
    'Printed'
  ]

  // Filter badges by name and status
  const validAndActiveBadges = user.badges
    // 1. Filter by Name: Must be in the WHITELIST
    .filter(badge => WHITELIST.includes(badge.badge_name))
    // 2. Filter by Status: Must contain at least one ALLOWED_STATUS
    .filter(badge => {
      // Use .some() to check if any status in the badge's statuses array is in ALLOWED_STATUSES
      return badge.statuses.some(status => ALLOWED_STATUSES.includes(status))
    })

  // The access check now uses the fully filtered list
  if (validAndActiveBadges.length === 0) {
    console.log(`api::validate::eventUrl.get user ${user.id} was denied access to courseEventId ${courseEventId}`) // eslint-disable-line no-console
    return {
      message: 'You are not allowed to access this page. with existing badges:',
      existingBadges: user.badges.map(badge => badge.badge_name)
    }
  }

  // Access Granted
  const videoUrl = await readCourseEventVideolevelsUrl(courseEventId)
  console.log(`api::validate::eventUrl.get user ${user.id} was granted access to courseEvent ${courseEventId}: ${videoUrl}`) // eslint-disable-line no-console

  try {
    const videoProvider = videoUrl.split('/')[2]
    const videoId = videoUrl.split('/bc/')[1].split('/')[0]
    return {
      message: 'You are allowed to access this video.',
      status: 200,
      videoUrl,
      videoProvider,
      videoId
    }
  } catch (error) {
    return {
      message: 'You are allowed to access the video but alas, there is no videoUrl.',
      status: 200,
      videoUrl: null,
      videoProvider: null,
      videoId: null
    }
  }
})
