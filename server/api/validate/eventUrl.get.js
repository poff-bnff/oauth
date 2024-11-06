export default defineEventHandler(async (event) => {
  const q = getQuery(event)
  const courseEventId = parseInt(Object.keys(q)[0])

  const id = getUserIdFromEvent(event)
  const user = await getStrapiUser(id)
  if (!user) throw createError({ statusCode: 404, statusMessage: 'Not Found' })

  await loadEventivalBadges(user)

  const WHITELIST = [
    '2024 MANAGEMENT',
    '2024 JURY',
    '2024 VIP',
    '2024 GUEST',
    '2024 TEAM',
    '2024 PRESS',
    '2024 PRESS ONLINE',
    '2024 VOLUNTEER GREEN',
    '2024 VOLUNTEER',
    '2024 Industry PRO',
    '2024 Industry PRO ONLINE',
    '2024 Industry Student / Talent',
    '2024 INTERN'
  ]
  const badges = user.badges
    .map(badge => badge.type.name)
    .filter(badgeName => WHITELIST.includes(badgeName))

  if (badges.length === 0) {
    console.log(`api::validate::eventUrl.get user ${user.id} was denied access to courseEventId ${courseEventId}`) // eslint-disable-line no-console
    return {
      message: 'You are not allowed to access this page. with existing badges:',
      existingBadges: user.badges.map(badge => badge.type.name)
    }
  }
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
