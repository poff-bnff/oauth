import { getStrapiToken, getUserIdFromEvent } from '../../utils/strapi.js'

// Converts a format the browser cannot decode into a JPEG the cropper can display.
//
// Only TIFF today: every engine except Safari refuses to decode it in an <img>, so without this a
// TIFF could never reach the cropper. HEIC is not covered — libheif on the Strapi box has no HEVC
// decoder, so sharp reads the container and not the contents.
//
// Requires a logged-in user. Strapi already runs sharp on arbitrary uploads through the media
// library, so this adds no capability an authenticated user did not already have — but it must not
// become an anonymous "decode this for me" service, hence the check below and the Public role
// deliberately NOT holding the `convert` permission.

// Bigger than the photo limit on purpose: a TIFF is typically several times the size of the JPEG
// it becomes, so judging it by the JPEG's 5 MB ceiling would reject ordinary scans.
const MAX_UPLOAD_BYTES = 25 * 1024 * 1024

export default defineEventHandler(async (event) => {
  const userId = getUserIdFromEvent(event)
  if (!userId) throw createError({ statusCode: 401, statusMessage: 'Unauthorized' })

  const { data } = (await readBody(event)) || {}
  const match = String(data || '').match(/^data:([^;]+);base64,(.+)$/)

  if (!match) {
    throw createError({ statusCode: 400, statusMessage: 'Expected a base64 data URL' })
  }

  // Length is checked here as well as in Strapi so an oversized body is rejected at the edge
  // rather than after being relayed across the network.
  if (Buffer.byteLength(match[2], 'base64') > MAX_UPLOAD_BYTES) {
    throw createError({ statusCode: 413, statusMessage: 'Image too large to convert' })
  }

  const config = useRuntimeConfig()

  try {
    const token = await getStrapiToken()
    const converted = await $fetch(`${config.strapiUrl}/photo-convert`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: { data },
      timeout: 30000
    })

    return converted
  } catch (err) {
    // Deliberately vague to the client, detailed in the log: the underlying message can echo
    // library internals.
    console.warn('[photo-convert] failed:', err?.message) // eslint-disable-line no-console
    throw createError({ statusCode: 400, statusMessage: 'Could not convert that image' })
  }
})
