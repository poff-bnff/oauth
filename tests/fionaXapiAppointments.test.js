/**
 * normalizeXapiAppointments / normalizeXapiProgrammes — the LIVE appointments of a login, read from the XAPI
 * (GET /account/MyPoff/{userId}/guestbook/{guestbook}/appointments?includeAttendees=true and .../meetingprogramparticipations),
 * shaped exactly like the ones read from the published accreditation card so the page needs no change. No publish step is
 * needed for these: they are what Fiona holds now. XAPI members have no person id, so the member that is the login is
 * recognised by name (Accreditation.Description), and nobody gets a profile link.
 */
import { describe, it, expect } from 'vitest'
import { normalizeXapiAppointments, normalizeXapiProgrammes } from '../server/utils/fiona/xapiAppointments.js'

const role = (key, text, abbreviation = null) => ({ Key: key, Translations: [{ Language: 'en', Text: text, Abbreviation: abbreviation }] })

function answer (appointments, overrides = {}) {
  return {
    Accreditation: { Id: 'acc-me', Description: 'Jaan Leppik' },
    AccreditationStatus: { Key: 'guest', Translations: [] },
    Appointments: appointments,
    ...overrides
  }
}

const oneOnOne = {
  Id: 'ap-1',
  AppointmentType: { Description: 'One-on-one meeting', Id: 'type-1' },
  StartsOn: '2026-11-13T06:00:00+00:00',
  EndsOn: '2026-11-13T06:15:00+00:00',
  Subject: 'TEST - One-on-one meeting',
  IsOnline: false,
  Location: { Description: 'Apollo Kino Tasku', Id: 'loc-1' },
  Table: null,
  InternalNotes: 'call him first, he is nervous',
  Members: [
    { FullName: 'Jaan Leppik', CompanyName: null, Role: null },
    { FullName: 'Ingel Iris Tofert', CompanyName: 'Some Co', Role: role('industry-representative', 'Industry representative', 'IR') }
  ]
}

describe('normalizeXapiAppointments', () => {
  it('gives an appointment the shape the page already knows', () => {
    const { appointments } = normalizeXapiAppointments(answer([oneOnOne]))

    expect(appointments).toEqual([{
      id: 'ap-1',
      type: { key: 'one-on-one-meeting', text: 'One-on-one meeting', abbreviation: null },
      startsOn: '2026-11-13T06:00:00.000Z',
      endsOn: '2026-11-13T06:15:00.000Z',
      subject: 'TEST - One-on-one meeting',
      location: 'Apollo Kino Tasku',
      isOnline: false,
      table: null,
      notes: null,
      members: [
        { id: null, name: 'Jaan Leppik', role: null, personId: null, isMe: true },
        { id: null, name: 'Ingel Iris Tofert', role: { key: 'industry-representative', text: 'Industry representative' }, personId: null, isMe: false }
      ]
    }])
  })

  it('never passes on the internal notes', () => {
    const { appointments } = normalizeXapiAppointments(answer([oneOnOne]))

    expect(JSON.stringify(appointments)).not.toContain('nervous')
    expect(appointments[0].notes).toBeNull()
  })

  it('turns times with any UTC offset into UTC, so they match the published card', () => {
    const { appointments } = normalizeXapiAppointments(answer([{ ...oneOnOne, StartsOn: '2026-11-13T08:00:00+02:00', EndsOn: '2026-11-13T08:15:00+02:00' }]))

    expect(appointments[0].startsOn).toBe('2026-11-13T06:00:00.000Z')
    expect(appointments[0].endsOn).toBe('2026-11-13T06:15:00.000Z')
  })

  it('sorts by start time and tolerates missing parts', () => {
    const later = { ...oneOnOne, Id: 'ap-late', StartsOn: '2026-11-14T06:00:00Z', EndsOn: null }
    const bare = { Id: 'ap-bare', StartsOn: '2026-11-12T06:00:00Z' }

    const { appointments } = normalizeXapiAppointments(answer([later, bare, oneOnOne]))

    expect(appointments.map(item => item.id)).toEqual(['ap-bare', 'ap-1', 'ap-late'])
    expect(appointments[0]).toMatchObject({ type: null, subject: '', location: null, isOnline: false, members: [] })
    expect(appointments[2].endsOn).toBeNull()
  })

  it('shows no type chip for a type that is not set', () => {
    for (const Description of ['', '-', 'Not set', null]) {
      const { appointments } = normalizeXapiAppointments(answer([{ ...oneOnOne, AppointmentType: { Description, Id: 't' } }]))

      expect(appointments[0].type).toBeNull()
    }
  })

  it('shows a role that is not set as no role', () => {
    const { appointments } = normalizeXapiAppointments(answer([{ ...oneOnOne, Members: [{ FullName: 'Jaan Leppik', Role: role('not-set', 'Not set') }] }]))

    expect(appointments[0].members[0].role).toBeNull()
  })

  it('marks the member whose name is the accreditation holder as the login, ignoring case and spacing', () => {
    const { appointments } = normalizeXapiAppointments(answer([{ ...oneOnOne, Members: [{ FullName: '  jaan   LEPPIK ' }, { FullName: 'Someone Else' }] }]))

    expect(appointments[0].members.map(member => member.isMe)).toEqual([true, false])
  })

  it('reads the accreditation and answers an empty list for no or a malformed answer', () => {
    expect(normalizeXapiAppointments(answer([oneOnOne])).accreditation).toEqual({ id: 'acc-me', description: 'Jaan Leppik', status: 'guest' })
    expect(normalizeXapiAppointments(null)).toEqual({ accreditation: null, appointments: [] })
    expect(normalizeXapiAppointments({ Appointments: null }).appointments).toEqual([])
    expect(normalizeXapiAppointments(answer([null, 'x', 7])).appointments).toEqual([])
  })

  it('treats an unreadable time as no time instead of failing', () => {
    const { appointments } = normalizeXapiAppointments(answer([{ ...oneOnOne, StartsOn: 'tomorrow', EndsOn: undefined }]))

    expect(appointments[0].startsOn).toBeNull()
    expect(appointments[0].endsOn).toBeNull()
  })
})

describe('normalizeXapiProgrammes', () => {
  const participations = {
    Accreditation: { Id: 'acc-me', Description: 'Jaan Leppik' },
    Schedules: [{
      Id: 's1',
      Name: 'One-on-one meetings 2026',
      MeetingPrograms: [{ Id: 'mp-1', Name: 'Film Market', MeetingRequestFormsOpensOn: '2026-10-28T22:00:00+00:00', MeetingRequestFormsClosesOn: '2026-11-14T22:00:00+00:00' }]
    }]
  }

  it('lists each meeting programme with its schedule, and when its meeting request form opens and closes', () => {
    expect(normalizeXapiProgrammes(participations)).toEqual([{
      id: 'mp-1',
      name: 'Film Market',
      schedule: 'One-on-one meetings 2026',
      role: null,
      requestsOpenOn: '2026-10-28T22:00:00.000Z',
      requestsCloseOn: '2026-11-14T22:00:00.000Z'
    }])
  })

  it('takes the role in the programme from the published card when it names the same programme, else shows none', () => {
    const published = [{ id: 'mp-1', name: 'Film Market', schedule: 'x', role: { key: 'industry-representative', text: 'Industry representative' } }]

    expect(normalizeXapiProgrammes(participations, { publishedProgrammes: published })[0].role).toEqual({ key: 'industry-representative', text: 'Industry representative' })
    expect(normalizeXapiProgrammes(participations, { publishedProgrammes: [{ id: 'other', role: { key: 'k', text: 't' } }] })[0].role).toBeNull()
  })

  it('answers an empty list for no or a malformed answer, and skips programmes without a name', () => {
    expect(normalizeXapiProgrammes(null)).toEqual([])
    expect(normalizeXapiProgrammes({ Schedules: null })).toEqual([])
    expect(normalizeXapiProgrammes({ Schedules: [{ Name: 's', MeetingPrograms: [{ Id: 'x' }, null] }] })).toEqual([])
  })
})
