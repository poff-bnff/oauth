import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../server/utils/rateLimiter.js', () => ({ hitLimit: vi.fn() }))
vi.mock('../server/utils/fionaSync.js', () => ({ buildPublicationClient: vi.fn(), buildStrapiGateway: vi.fn() }))
vi.mock('../server/utils/fiona/myAppointments.js', () => ({ appointmentsForPerson: vi.fn() }))

const { hitLimit } = await import('../server/utils/rateLimiter.js')
const { buildPublicationClient, buildStrapiGateway } = await import('../server/utils/fionaSync.js')
const { appointmentsForPerson } = await import('../server/utils/fiona/myAppointments.js')

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
    getStrapiUser.mockResolvedValue({ id: 5, person: { id: 77 } })
    getStrapiPerson.mockResolvedValue({ id: 77, fiona_person_id: 'fp', fiona_accreditation_id: 'acc' })
    getQuery.mockReturnValue({})
    hitLimit.mockReturnValue({ exceeded: false, retryAfter: 0 })
    buildPublicationClient.mockReturnValue({ publication: true })
    buildStrapiGateway.mockReturnValue({ gateway: true })
    appointmentsForPerson.mockResolvedValue({ ...EMPTY, appointments: [{ id: 'a' }] })
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

  it('has nothing to show for a user without a person, and does not reach for Fiona', async () => {
    getStrapiUser.mockResolvedValue({ id: 5, person: null })
    expect(await handler(event)).toEqual(EMPTY)

    getStrapiUser.mockResolvedValue({ id: 5, person: {} })
    expect(await handler(event)).toEqual(EMPTY)

    expect(buildPublicationClient).not.toHaveBeenCalled()
    expect(appointmentsForPerson).not.toHaveBeenCalled()
  })

  it('shows the appointments of the person of the logged-in user, in English unless Estonian is asked for, and never lets the browser keep them', async () => {
    const result = await handler(event)

    expect(result).toEqual({ ...EMPTY, appointments: [{ id: 'a' }] })
    expect(getStrapiPerson).toHaveBeenCalledWith(77)
    expect(appointmentsForPerson).toHaveBeenCalledWith({
      person: { id: 77, fiona_person_id: 'fp', fiona_accreditation_id: 'acc' },
      publication: { publication: true },
      strapi: { gateway: true },
      lang: 'en'
    })
    expect(setHeader).toHaveBeenCalledWith(event, 'Cache-Control', 'no-store')

    getQuery.mockReturnValue({ lang: 'et' })
    await handler(event)
    expect(appointmentsForPerson.mock.calls[1][0].lang).toBe('et')

    getQuery.mockReturnValue({ lang: 'xx' })
    await handler(event)
    expect(appointmentsForPerson.mock.calls[2][0].lang).toBe('en')
  })

  it('says "unavailable" instead of failing when Fiona is not configured or breaks unexpectedly', async () => {
    buildPublicationClient.mockImplementation(() => { throw new Error('NUXT_FIONA_PUBLICATION_API_KEY is not configured') })
    expect(await handler(event)).toEqual({ ok: false, error: 'unavailable', programmes: [], appointments: [] })

    buildPublicationClient.mockReturnValue({})
    appointmentsForPerson.mockRejectedValue(new Error('boom'))
    expect(await handler(event)).toEqual({ ok: false, error: 'unavailable', programmes: [], appointments: [] })
  })
})
