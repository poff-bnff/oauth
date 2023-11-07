export default defineEventHandler(async (event) => {
  const id = getUserIdFromEvent(event)
  const user = await getStrapiUser(id)
  console.log('api::validate::eventUrl.get', id) // eslint-disable-line no-console
  if (!user) throw createError({ statusCode: 404, statusMessage: 'Not Found' })
  await loadEventivalBadges(user)

  const whitelist = [
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
    .map(badge => badge.name)
    .filter(badgeName => whitelist.includes(badgeName))
  if (badges.length === 0) {
    return {
      status: 403,
      message: 'You are not allowed to access this page. with existing badges:',
      existingBadges: user.badges
    }
  }

  const courseEventId = parseInt(await readBody(event))

  const courseEventUrl = await readCourseEventVideolevelsUrl(courseEventId)
  return courseEventUrl
})
