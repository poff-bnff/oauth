/**
 * appointmentsForUserFresh — appointmentsForUser with caches of its own, so a probe reads the published card from Fiona every
 * time instead of sharing hunt's live caches.
 */
import { describe, it, expect, vi } from 'vitest'
import { appointmentsForUserFresh } from '../server/utils/fiona/loginAppointments.js'

describe('appointmentsForUserFresh', () => {
  it('reads the published card from Fiona on every call', async () => {
    const getRaw = vi.fn().mockResolvedValue({ appointments: [{ id: 'a', subject: 'TEST', startsOn: '2026-11-12T06:00:00Z', members: [] }], meetingProgramParticipations: [] })
    const publication = { getRaw }
    const user = { id: 5, person: { id: 77 }, aliasUsers: [] }
    const loadPerson = () => Promise.resolve({ id: 77, fiona_person_id: 'fp-1', fiona_accreditation_id: 'acc-1' })
    const strapi = { getActiveGuestbookIds: () => Promise.resolve([]), findPeopleByFionaIds: () => Promise.resolve([]) }

    const first = await appointmentsForUserFresh({ user, loadPerson, publication, xapi: null, strapi })
    await appointmentsForUserFresh({ user, loadPerson, publication, xapi: null, strapi })

    expect(first.appointments.map(item => item.id)).toEqual(['a'])
    expect(getRaw).toHaveBeenCalledTimes(2)
  })
})
