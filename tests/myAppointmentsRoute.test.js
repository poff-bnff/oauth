import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../server/utils/rateLimiter.js', () => ({ hitLimit: vi.fn() }))
vi.mock('../server/utils/fionaSync.js', () => ({ buildPublicationClient: vi.fn(), buildXapiClient: vi.fn(), buildStrapiGateway: vi.fn() }))
vi.mock('../server/utils/fiona/loginAppointments.js', () => ({ appointmentsForUser: vi.fn() }))
vi.mock('../server/utils/fiona/loginLiveAppointments.js', () => ({ appointmentsForLogin: vi.fn() }))
vi.mock('../server/utils/fiona/myAppointments.js', () => ({ appointmentsForPerson: vi.fn() }))

const { hitLimit } = await import('../server/utils/rateLimiter.js')
const { buildPublicationClient, buildXapiClient, buildStrapiGateway } = await import('../server/utils/fionaSync.js')
const { appointmentsForUser } = await import('../server/utils/fiona/loginAppointments.js')
const { appointmentsForLogin } = await import('../server/utils/fiona/loginLiveAppointments.js')
const { appointmentsForPerson } = await import('../server/utils/fiona/myAppointments.js')
const { clearAppointmentsCaches } = await import('../server/utils/fiona/appointmentsCaches.js')

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
    clearAppointmentsCaches()
    delete process.env.MY_APPOINTMENTS_ENABLED
    getUserIdFromEvent.mockReturnValue(5)
    getStrapiUser.mockResolvedValue({ id: 5, person: { id: 77 }, aliasUsers: [] })
    getQuery.mockReturnValue({})
    hitLimit.mockReturnValue({ exceeded: false, retryAfter: 0 })
    buildPublicationClient.mockReturnValue({ publication: true })
    buildXapiClient.mockReturnValue({ xapi: true })
    buildStrapiGateway.mockReturnValue({ gateway: true })
    appointmentsForUser.mockResolvedValue({ ...EMPTY, appointments: [{ id: 'a' }] })
    appointmentsForLogin.mockImplementation(({ fallback }) => fallback())
    delete process.env.MY_APPOINTMENTS_LIVE
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
      loadPerson: expect.any(Function),
      publication: { publication: true },
      xapi: { xapi: true },
      strapi: expect.objectContaining({ gateway: true, getActiveGuestbookIds: expect.any(Function) }),
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

  describe('keeps the Strapi reads that every page view repeated', () => {
    it('reads the user from Strapi once and still asks the appointments code on every request', async () => {
      await handler(event)
      await handler(event)
      await handler(event)

      expect(getStrapiUser).toHaveBeenCalledTimes(1)
      expect(appointmentsForUser).toHaveBeenCalledTimes(3)
    })

    it('keeps the users apart', async () => {
      getStrapiUser.mockImplementation(id => Promise.resolve({ id, person: null, aliasUsers: [] }))

      getUserIdFromEvent.mockReturnValue(5)
      await handler(event)
      getUserIdFromEvent.mockReturnValue(6)
      await handler(event)
      getUserIdFromEvent.mockReturnValue(5)
      await handler(event)

      expect(getStrapiUser.mock.calls.map(([id]) => id)).toEqual([5, 6])
      expect(appointmentsForUser.mock.calls[1][0].user.id).toBe(6)
    })

    it('does not remember a user that was not found, or a read that failed', async () => {
      getStrapiUser.mockResolvedValueOnce(null)
      await expect(handler(event)).rejects.toMatchObject({ statusCode: 404 })

      getStrapiUser.mockRejectedValueOnce(new Error('504 Gateway Time-out'))
      await expect(handler(event)).rejects.toThrow('504')

      expect(await handler(event)).toEqual({ ...EMPTY, appointments: [{ id: 'a' }] })
      expect(getStrapiUser).toHaveBeenCalledTimes(3)
    })

    it('gives the appointments code a person loader that reads each person from Strapi once, across requests', async () => {
      getStrapiPerson.mockImplementation(id => Promise.resolve({ id }))
      await handler(event)
      await handler(event)
      const { loadPerson } = appointmentsForUser.mock.calls[0][0]
      const { loadPerson: second } = appointmentsForUser.mock.calls[1][0]

      expect(await loadPerson(77)).toEqual({ id: 77 })
      expect(await second(77)).toEqual({ id: 77 })
      expect(await second('77')).toEqual({ id: 77 })
      expect(await loadPerson(78)).toEqual({ id: 78 })

      expect(getStrapiPerson.mock.calls.map(([id]) => String(id))).toEqual(['77', '78'])
    })

    it('gives the appointments code a gateway whose active-guestbooks read goes to Strapi once, and leaves its other methods alone', async () => {
      const gateway = { getActiveGuestbookIds: vi.fn().mockResolvedValue(['gb-1']), findPeopleByFionaIds: vi.fn() }
      buildStrapiGateway.mockReturnValue(gateway)
      await handler(event)
      await handler(event)
      const first = appointmentsForUser.mock.calls[0][0].strapi
      const second = appointmentsForUser.mock.calls[1][0].strapi

      expect(await first.getActiveGuestbookIds()).toEqual(['gb-1'])
      expect(await second.getActiveGuestbookIds()).toEqual(['gb-1'])

      expect(gateway.getActiveGuestbookIds).toHaveBeenCalledTimes(1)
      expect(first.findPeopleByFionaIds).toBe(gateway.findPeopleByFionaIds)
    })
  })

  describe('reads Fiona live first', () => {
    it('hands the user, the XAPI client, the language and the cached Strapi gateway to appointmentsForLogin, and answers what it answers', async () => {
      appointmentsForLogin.mockResolvedValue({ ok: true, source: 'live', programmes: [], appointments: [{ id: 'live-1' }] })

      const result = await handler(event)

      expect(result).toEqual({ ok: true, source: 'live', programmes: [], appointments: [{ id: 'live-1' }] })
      expect(appointmentsForLogin).toHaveBeenCalledWith({
        user: { id: 5, person: { id: 77 }, aliasUsers: [] },
        xapi: { xapi: true },
        strapi: expect.objectContaining({ gateway: true, getActiveGuestbookIds: expect.any(Function) }),
        lang: 'en',
        readCardProgrammes: expect.any(Function),
        fallback: expect.any(Function)
      })
      expect(appointmentsForUser).not.toHaveBeenCalled()
    })

    it('uses the published-card path (appointmentsForUser) as the fallback, with the same arguments as before', async () => {
      await handler(event)

      expect(appointmentsForUser).toHaveBeenCalledWith({
        user: { id: 5, person: { id: 77 }, aliasUsers: [] },
        loadPerson: expect.any(Function),
        publication: { publication: true },
        xapi: { xapi: true },
        strapi: expect.objectContaining({ gateway: true }),
        lang: 'en'
      })
    })

    it('reads no live data when MY_APPOINTMENTS_LIVE is "false" or when no XAPI client is configured', async () => {
      process.env.MY_APPOINTMENTS_LIVE = ' False '
      await handler(event)
      expect(appointmentsForLogin.mock.calls[0][0].xapi).toBeNull()

      delete process.env.MY_APPOINTMENTS_LIVE
      buildXapiClient.mockReturnValue(null)
      await handler(event)
      expect(appointmentsForLogin.mock.calls[1][0].xapi).toBeNull()
    })

    it('does not need the Publication client for the live answer: it is built only when the fallback or the programme roles run', async () => {
      buildPublicationClient.mockImplementation(() => { throw new Error('NUXT_FIONA_PUBLICATION_API_KEY is not configured') })
      appointmentsForLogin.mockResolvedValue({ ok: true, source: 'live', programmes: [], appointments: [] })

      expect(await handler(event)).toEqual({ ok: true, source: 'live', programmes: [], appointments: [] })
      expect(buildPublicationClient).not.toHaveBeenCalled()
    })

    it('reads the programmes of the published cards by accreditation id for the roles, without any Strapi read for profile links', async () => {
      appointmentsForPerson.mockResolvedValue({ ok: true, programmes: [{ id: 'mp-1', role: { key: 'ir', text: 'IR' } }], appointments: [] })
      appointmentsForLogin.mockResolvedValue({ ok: true, programmes: [], appointments: [] })
      await handler(event)
      const { readCardProgrammes } = appointmentsForLogin.mock.calls[0][0]

      expect(await readCardProgrammes(['acc-1', 'acc-2'])).toEqual([{ id: 'mp-1', role: { key: 'ir', text: 'IR' } }])

      const call = appointmentsForPerson.mock.calls[0][0]
      expect(call.person).toEqual({ fiona_person_id: null, fiona_accreditation_id: 'acc-1,acc-2' })
      expect(call.publication).toEqual({ publication: true })
      expect(call.lang).toBe('en')
      expect(await call.strapi.findPeopleByFionaIds(['x'])).toEqual([])
    })

    it('says "unavailable" when the live-first function itself fails', async () => {
      appointmentsForLogin.mockRejectedValue(new Error('boom'))

      expect(await handler(event)).toEqual({ ok: false, error: 'unavailable', programmes: [], appointments: [] })
    })
  })

  describe('the switch', () => {
    it.each([undefined, '', 'true', '1', 'yes'])('is on when MY_APPOINTMENTS_ENABLED is %j', async (value) => {
      if (value === undefined) delete process.env.MY_APPOINTMENTS_ENABLED
      else process.env.MY_APPOINTMENTS_ENABLED = value

      expect(await handler(event)).toEqual({ ...EMPTY, appointments: [{ id: 'a' }] })
      expect(appointmentsForUser).toHaveBeenCalledTimes(1)
    })

    it.each(['false', 'FALSE', ' false '])('is off when MY_APPOINTMENTS_ENABLED is %j: an empty list, without touching Strapi or Fiona', async (value) => {
      process.env.MY_APPOINTMENTS_ENABLED = value

      const result = await handler(event)

      expect(result).toEqual(EMPTY)
      expect(getStrapiUser).not.toHaveBeenCalled()
      expect(getStrapiPerson).not.toHaveBeenCalled()
      expect(appointmentsForUser).not.toHaveBeenCalled()
      expect(buildPublicationClient).not.toHaveBeenCalled()
      expect(buildXapiClient).not.toHaveBeenCalled()
      expect(buildStrapiGateway).not.toHaveBeenCalled()
      expect(setHeader).toHaveBeenCalledWith(event, 'Cache-Control', 'no-store')
    })

    it('still refuses a request without a valid login while it is off', async () => {
      process.env.MY_APPOINTMENTS_ENABLED = 'false'
      getUserIdFromEvent.mockImplementation(() => { throw Object.assign(new Error('Unauthorized'), { statusCode: 401 }) })

      await expect(handler(event)).rejects.toMatchObject({ statusCode: 401 })
    })
  })
})
