async function getOwnBusinessProfile (config, token, id, userId) {
  const params = new URLSearchParams()
  params.append('id', id)
  params.append('_where[user]', userId)

  const profiles = await $fetch(`${config.strapiUrl}/business-profiles?${params.toString()}`, {
    headers: {
      Authorization: `Bearer ${token}`
    }
  })

  return Array.isArray(profiles) ? profiles[0] : null
}

export default defineEventHandler(async (event) => {
  const config = useRuntimeConfig()
  const userId = getUserIdFromEvent(event)
  const adminToken = await getStrapiAdminToken()
  const id = event.context.params.id
  const body = await readBody(event)
  const profile = await getOwnBusinessProfile(config, adminToken, id, userId)
  const validationError = validateBusinessProfileBody(body)

  if (!profile) {
    throw createError({ statusCode: 404, statusMessage: 'Business profile not found' })
  }
  if (validationError) {
    throw createError({ statusCode: 400, statusMessage: validationError })
  }

  return await $fetch(`${config.strapiUrl}/business-profiles/${id}`, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${adminToken}`,
      'Content-Type': 'application/json'
    },
    body: {
      ...body,
      user: userId
    }
  })
})

function clean (value) {
  return String(value || '').trim()
}

function validEmail (value) {
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(clean(value))
}

function validateBusinessProfileBody (body = {}) {
  const isOrganisation = Boolean(clean(body.org_name) || clean(body.reg_code) || clean(body.vat_code))
  const missing = []

  if (!validEmail(body.email_for_invoice)) return 'Valid invoice email is required'

  if (isOrganisation) {
    if (!clean(body.org_name)) missing.push('company name')
    if (!clean(body.reg_code)) missing.push('registry code')
    if (!clean(body.firstNameLastName)) missing.push('contact person')
    if (!clean(body.address?.street_name)) missing.push('address')
    if (!clean(body.address?.add_municipality)) missing.push('city')
    if (!clean(body.address?.postal_code)) missing.push('postal code')
    if (!clean(body.address?.add_country)) missing.push('country')
  } else {
    if (!clean(body.firstName)) missing.push('first name')
    if (!clean(body.lastName)) missing.push('last name')
  }

  return missing.length ? `Missing required invoice field(s): ${missing.join(', ')}` : ''
}
