export default defineEventHandler(async (event) => {
  // const query = getQuery(event)
  // const courseEventId = parseInt(Object.keys(query)[0])
  const courseEventId = parseInt(await readBody(event))
  return courseEventId
  console.log('api::validate::eventUrl.get', { id, query, courseEventId, courseEventId2 }) // eslint-disable-line no-console

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
  console.log('api::validate::eventUrl.get badges loaded', user.badges.map(badge => badge.type.name), badges) // eslint-disable-line no-console

  if (badges.length === 0) {
    console.log('api::validate::eventUrl.get no badges', user.badges.map(badge => badge.type.name)) // eslint-disable-line no-console
    return {
      message: 'You are not allowed to access this page. with existing badges:',
      existingBadges: user.badges.map(badge => badge.type.name)
    }
  }
  console.log('api::validate::eventUrl.get badges', badges) // eslint-disable-line no-console
  const courseEventUrl = await readCourseEventVideolevelsUrl(courseEventId)
  console.log('api::validate::eventUrl.get courseEventUrl', courseEventUrl) // eslint-disable-line no-console
  return courseEventUrl
})
