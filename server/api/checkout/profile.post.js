export default defineEventHandler(async (event) => {
  const userId = getUserIdFromEvent(event)
  if (!userId) throw createError({ statusCode: 401, statusMessage: 'Unauthorized' })

  const { firstName, lastName, email, photo } = (await readBody(event)) || {}

  if (!firstName?.trim() || !lastName?.trim() || !email?.trim()) {
    throw createError({ statusCode: 400, statusMessage: 'firstName, lastName, and email are required' })
  }

  const user = await getStrapiUser(userId)
  const profileId = user.user_profile?.id
  if (!profileId) throw createError({ statusCode: 500, statusMessage: 'User profile not found' })

  let pictureId = user.user_profile?.picture?.id || user.user_profile?.picture || undefined

  if (photo?.data) {
    const match = String(photo.data).match(/^data:([^;]+);base64,(.+)$/)
    if (match && match[1].includes('image/')) {
      const buffer = Buffer.from(match[2], 'base64')
      if (buffer.length > 0 && buffer.length <= 5 * 1024 * 1024) {
        const ext = (photo.name?.includes('.') ? photo.name.split('.').pop() : '') || match[1].split('/')[1] || 'jpg'
        const filename = `checkout-buyer-${String(email.trim()).replace(/[^a-z0-9]+/gi, '-').toLowerCase()}.${ext}`
        const pic = await uploadStrapiImage({ name: 'picture', filename, data: buffer }, 'user-profile', profileId)
        if (pic?.id) pictureId = pic.id
      }
    }
  }

  await setStrapiUserProfile(profileId, {
    firstName: firstName.trim(),
    lastName: lastName.trim(),
    email: email.trim(),
    ...(pictureId !== undefined ? { picture: pictureId } : {})
  })

  return {
    ok: true,
    firstName: firstName.trim(),
    lastName: lastName.trim(),
    email: email.trim()
  }
})
