export default defineEventHandler(async (event) => {
  const id = getUserIdFromEvent(event)
  const user = await getStrapiUser(id)
  if (!user) throw createError({ statusCode: 404, statusMessage: 'Not Found' })

  const {mainUser, aliasUsers} = await getStrapiUsers(user)
  const users = [mainUser, ...aliasUsers]

  return users.map(user => {
    return {
      id: user.id,
      username: user.username,
      email: user.email,
      aliasUsers: user.aliasUsers,
      mainUser: user.mainUser
    }
  })
})
