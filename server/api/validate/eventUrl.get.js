export default defineEventHandler(async (event) => {
  const q = getQuery(event)
  const courseEventId = parseInt(Object.keys(q)[0])

  const id = getUserIdFromEvent(event)
  const user = await getStrapiUser(id)
  if (!user) throw createError({ statusCode: 404, statusMessage: 'Not Found' })

  await loadEventivalBadges(user)

  const WHITELIST = [
    '2023 GUEST',
    '2023 Industry PRO ONLINE',
    '2023 Industry PRO',
    '2023 Industry Student / Talent ONLINE',
    '2023 Industry Student / Talent',
    '2023 INTERN',
    '2023 JURY',
    '2023 JUST FILM INDUSTRY DAYS',
    '2023 MANAGEMENT',
    '2023 PRESS ONLINE',
    '2023 PRESS',
    '2023 TEAM',
    '2023 VOLUNTEER GREEN',
    '2023 VOLUNTEER'
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
  const courseEventUrl = await readCourseEventVideolevelsUrl(courseEventId)
  console.log(`api::validate::eventUrl.get user ${user.id} was granted access to courseEvent ${courseEventId}: ${courseEventUrl}`) // eslint-disable-line no-console
  return courseEventUrl
})
