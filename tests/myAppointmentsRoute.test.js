import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../server/utils/rateLimiter.js', () => ({ hitLimit: vi.fn() }))
vi.mock('../server/utils/fionaSync.js', () => ({ buildPublicationClient: vi.fn(), buildXapiClient: vi.fn(), buildStrapiGateway: vi.fn() }))
vi.mock('../server/utils/fiona/loginAppointments.js', () => ({ appointmentsForUser: vi.fn() }))

const { hitLimit } = await import('../server/utils/rateLimiter.js')
const { buildPublicationClient, buildXapiClient, buildStrapiGateway } = await import('../server/utils/fionaSync.js')
const { appointmentsForUser } = await import('../server/utils/fiona/loginAppointments.js')

// Nitro auto-imports of server/utils/strapi.js and h3, stubbed as globals
globalThis.defineEventHandler = handler => handler
globalThis.getUserIdFromEvent = vi.fn()
globalThis.getStrapiUser = vi.fn()
globalThis.getStrapiPerson = vi.fn()
globalThis.setHeader = vi.fn()
globalThis.getQuery = vi.fn()

const handler = (await import('../server/api/my/appointments.get.js')).default
const event = {}
const EMPTY = { ok: true, programmes: [], appointments: [] }

describe('GET /api/my/appointments', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    getUserIdFromEvent.mockReturnValue(5)
    getStrapiUser.mockResolvedValue({ id: 5, person: { id: 77 }, aliasUsers: [] })
    getQuery.mockReturnValue({})
    hitLimit.mockReturnValue({ exceeded: false, retryAfter: 0 })
    buildPublicationClient.mockReturnValue({ publication: true })
    buildXapiClient.mockReturnValue({ xapi: true })
    buildStrapiGateway.mockReturnValue({ gateway: true })
    appointmentsForUser.mockResolvedValue({ ...EMPTY, appointments: [{ id: 'a' }] })
  })

  it('refuses a request without a valid login before it does anything else', async () => {
    getUserIdFromEvent.mockImplementation(() => { throw Object.assign(new Error('Unauthorized'), { statusCode: 401 }) })

    await expect(handler(event)).rejects.toMatchObject({ statusCode: 401 })

    expect(hitLimit).not.toHaveBeenCalled()
    expect(getStrapiUser).not.toHaveBeenCalled()
  })

  it('limits each user to 30 requests a minute and says when to come back', async () => {
    hitLimit.mockReturnValue({ exceeded: true, retryAfter: 42 })

    await expect(handler(event)).rejects.toMatchObject({ statusCode: 429 })

    expect(hitLimit).toHaveBeenCalledWith('appointments:5', 30, 60 * 1000)
    expect(setHeader).toHaveBeenCalledWith(event, 'Retry-After', 42)
    expect(getStrapiUser).not.toHaveBeenCalled()
  })

  it('answers 404 when the login belongs to no user', async () => {
    getStrapiUser.mockResolvedValue(null)

    await expect(handler(event)).rejects.toMatchObject({ statusCode: 404 })
  })

  it('hands the logged-in user, the loader of persons and the Fiona and Strapi clients to appointmentsForUser, in English unless Estonian is asked for, and never lets the browser keep the answer', async () => {
    const result = await handler(event)

    expect(result).toEqual({ ...EMPTY, appointments: [{ id: 'a' }] })
    expect(appointmentsForUser).toHaveBeenCalledWith({
      user: { id: 5, person: { id: 77 }, aliasUsers: [] },
      loadPerson: getStrapiPerson,
      publication: { publication: true },
      xapi: { xapi: true },
      strapi: { gateway: true },
      lang: 'en'
    })
    expect(setHeader).toHaveBeenCalledWith(event, 'Cache-Control', 'no-store')

    getQuery.mockReturnValue({ lang: 'et' })
    await handler(event)
    expect(appointmentsForUser.mock.calls[1][0].lang).toBe('et')

    getQuery.mockReturnValue({ lang: 'xx' })
    await handler(event)
    expect(appointmentsForUser.mock.calls[2][0].lang).toBe('en')
  })

  it('looks only at the logged-in user: nothing from the browser but the language reaches appointmentsForUser', async () => {
    getQuery.mockReturnValue({ lang: 'en', userId: '999', accreditation: 'acc-x', person: '1' })

    await handler(event)

    expect(getStrapiUser).toHaveBeenCalledWith(5)
    expect(Object.keys(appointmentsForUser.mock.calls[0][0]).sort()).toEqual(['lang', 'loadPerson', 'publication', 'strapi', 'user', 'xapi'])
  })

  it('says "unavailable" instead of failing when Fiona is not configured or breaks unexpectedly', async () => {
    buildPublicationClient.mockImplementation(() => { throw new Error('NUXT_FIONA_PUBLICATION_API_KEY is not configured') })
    expect(await handler(event)).toEqual({ ok: false, error: 'unavailable', programmes: [], appointments: [] })

    buildPublicationClient.mockReturnValue({})
    appointmentsForUser.mockRejectedValue(new Error('boom'))
    expect(await handler(event)).toEqual({ ok: false, error: 'unavailable', programmes: [], appointments: [] })
  })
})
