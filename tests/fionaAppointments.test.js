import { describe, it, expect } from 'vitest'
import { normalizeAppointments } from '../server/utils/fiona/appointments.js'

const tr = (en, et, abbreviation = null) => [
  { language: 'et', text: et, abbreviation },
  { language: 'en', text: en, abbreviation }
]

// shape of a real Publication API accreditation card (Eunhye Hong Kim, 2026-11-11), values shortened
function blackCarpet (overrides = {}) {
  return {
    id: 'appt-bc',
    appointmentType: { key: 'black-carpet', translations: tr('Black Carpet', 'Must vaip', 'BC') },
    startsOn: '2026-11-09T10:30:00.000Z',
    endsOn: '2026-11-09T10:45:00.000Z',
    subject: 'Black Carpet / The Bully Club',
    isOnline: false,
    location: { id: 'loc-bc', description: 'Plaza, Black Carpet fotosein', isOnline: false, abbreviation: null },
    showId: 'show-1',
    filmId: null,
    table: null,
    publicationNotes: null,
    members: [
      { id: 'm1', personId: 'fp-me', accreditationId: 'acc-me', personFullName: 'Eunhye Hong Kim', role: { key: 'film-maker', translations: tr('Film-maker', 'Filmitegija') } },
      { id: 'm2', personId: 'fp-2', accreditationId: 'acc-2', personFullName: 'Some Producer', role: { key: 'companion', translations: tr('Companion', 'Kaaslane') } }
    ],
    ...overrides
  }
}

const card = (overrides = {}) => ({
  appointments: [blackCarpet()],
  meetingProgramParticipations: [{
    hideForMeetingRequests: false,
    meetingProgram: { id: 'prog-film', description: 'Film Market', schedule: { id: 'sch-1', description: 'One-on-one meetings 2026' } },
    role: { key: 'industry-representative', translations: tr('Industry representative', 'Tööstuse esindaja', 'IndRep.') }
  }],
  ...overrides
})

describe('normalizeAppointments', () => {
  it('turns an appointment into type, time, subject, place and the people in it', () => {
    const { appointments } = normalizeAppointments(card(), { lang: 'en', myAccreditationIds: ['acc-me'] })

    expect(appointments).toEqual([{
      id: 'appt-bc',
      type: { key: 'black-carpet', text: 'Black Carpet', abbreviation: 'BC' },
      startsOn: '2026-11-09T10:30:00.000Z',
      endsOn: '2026-11-09T10:45:00.000Z',
      subject: 'Black Carpet / The Bully Club',
      location: 'Plaza, Black Carpet fotosein',
      isOnline: false,
      table: null,
      notes: null,
      members: [
        { id: 'm1', name: 'Eunhye Hong Kim', role: { key: 'film-maker', text: 'Film-maker' }, personId: 'fp-me', isMe: true },
        { id: 'm2', name: 'Some Producer', role: { key: 'companion', text: 'Companion' }, personId: 'fp-2', isMe: false }
      ]
    }])
  })

  it('sorts the appointments by start time, then end time', () => {
    const late = blackCarpet({ id: 'late', startsOn: '2026-11-09T13:30:00.000Z', endsOn: '2026-11-09T14:00:00.000Z' })
    const early = blackCarpet({ id: 'early', startsOn: '2026-11-09T10:30:00.000Z', endsOn: '2026-11-09T10:45:00.000Z' })
    const middleLong = blackCarpet({ id: 'middle-long', startsOn: '2026-11-09T11:05:00.000Z', endsOn: '2026-11-09T12:30:00.000Z' })
    const middleShort = blackCarpet({ id: 'middle-short', startsOn: '2026-11-09T11:05:00.000Z', endsOn: '2026-11-09T11:30:00.000Z' })

    const { appointments } = normalizeAppointments(card({ appointments: [late, middleLong, early, middleShort] }))

    expect(appointments.map(a => a.id)).toEqual(['early', 'middle-short', 'middle-long', 'late'])
  })

  it('uses the texts of the requested language, then English, then whatever exists', () => {
    const only = { key: 'x', translations: [{ language: 'de', text: 'Nur Deutsch', abbreviation: 'D' }] }
    const raw = card({ appointments: [blackCarpet({ appointmentType: { key: 'q-a', translations: tr('Q&A', 'K&V', 'QA') } }), blackCarpet({ id: 'b', appointmentType: only })] })

    const et = normalizeAppointments(raw, { lang: 'et' }).appointments
    expect(et[0].type.text).toBe('K&V')
    expect(et[0].members[0].role.text).toBe('Filmitegija')

    const unknown = normalizeAppointments(raw, { lang: 'fr' }).appointments
    expect(unknown[0].type.text).toBe('Q&A') // English

    const onlyGerman = normalizeAppointments(raw, { lang: 'en' }).appointments.find(a => a.id === 'b')
    expect(onlyGerman.type).toEqual({ key: 'x', text: 'Nur Deutsch', abbreviation: 'D' })
  })

  it('has no type for "not set" or a missing type', () => {
    const notSet = blackCarpet({ id: 'a', appointmentType: { key: 'not-set', translations: tr('-', '-', '-') } })
    const none = blackCarpet({ id: 'b', appointmentType: null })

    const { appointments } = normalizeAppointments(card({ appointments: [notSet, none] }))

    expect(appointments.map(a => a.type)).toEqual([null, null])
  })

  it('marks the people that are the user, by accreditation or by Fiona person, and drops members without a name', () => {
    const raw = card({
      appointments: [blackCarpet({
        members: [
          { id: 'a', personId: 'fp-me', accreditationId: 'someone-else', personFullName: 'Me By Person', role: null },
          { id: 'b', personId: 'fp-9', accreditationId: 'acc-me', personFullName: 'Me By Accreditation', role: null },
          { id: 'c', personId: 'fp-3', accreditationId: 'acc-3', personFullName: 'Other', role: null },
          { id: 'd', personId: 'fp-4', accreditationId: 'acc-4', personFullName: '  ', role: null },
          { id: 'e', personId: 'fp-5', accreditationId: 'acc-5', role: null }
        ]
      })]
    })

    const [{ members }] = normalizeAppointments(raw, { myPersonId: 'fp-me', myAccreditationIds: ['acc-me'] }).appointments

    expect(members.map(m => [m.name, m.isMe, m.role])).toEqual([
      ['Me By Person', true, null],
      ['Me By Accreditation', true, null],
      ['Other', false, null]
    ])
  })

  it('is online when the appointment or its location is', () => {
    const raw = card({
      appointments: [
        blackCarpet({ id: 'a', isOnline: true }),
        blackCarpet({ id: 'b', location: { id: 'l', description: 'Zoom', isOnline: true } }),
        blackCarpet({ id: 'c', location: null })
      ]
    })

    const { appointments } = normalizeAppointments(raw)

    expect(appointments.map(a => [a.id, a.isOnline, a.location])).toEqual([['a', true, 'Plaza, Black Carpet fotosein'], ['b', true, 'Zoom'], ['c', false, null]])
  })

  it('passes on the table and the publication notes when there are any, as plain text', () => {
    const raw = card({
      appointments: [
        blackCarpet({ id: 'a', table: 'Table 12', publicationNotes: 'Bring your badge' }),
        blackCarpet({ id: 'b', table: { description: 'Table 7' }, publicationNotes: '   ' }),
        blackCarpet({ id: 'c', table: { unknown: 1 } })
      ]
    })

    const [a, b, c] = normalizeAppointments(raw).appointments

    expect([a.table, a.notes]).toEqual(['Table 12', 'Bring your badge'])
    expect([b.table, b.notes]).toEqual(['Table 7', null])
    expect(c.table).toBeNull()
  })

  it('lists the meeting programmes with schedule and role, once each', () => {
    const participation = card().meetingProgramParticipations[0]
    const series = {
      hideForMeetingRequests: false,
      meetingProgram: { id: 'prog-series', description: 'Series Market', schedule: { id: 'sch-1', description: 'One-on-one meetings 2026' } },
      role: participation.role
    }

    const { programmes } = normalizeAppointments(card({ meetingProgramParticipations: [participation, series, participation] }), { lang: 'et' })

    expect(programmes).toEqual([
      { id: 'prog-film', name: 'Film Market', schedule: 'One-on-one meetings 2026', role: { key: 'industry-representative', text: 'Tööstuse esindaja' } },
      { id: 'prog-series', name: 'Series Market', schedule: 'One-on-one meetings 2026', role: { key: 'industry-representative', text: 'Tööstuse esindaja' } }
    ])
  })

  it('only passes on what the page shows: no ids of films, shows or locations, no hide flag', () => {
    const { appointments, programmes } = normalizeAppointments(card())

    expect(Object.keys(appointments[0]).sort()).toEqual(['endsOn', 'id', 'isOnline', 'location', 'members', 'notes', 'startsOn', 'subject', 'table', 'type'])
    expect(Object.keys(appointments[0].members[0]).sort()).toEqual(['id', 'isMe', 'name', 'personId', 'role'])
    expect(Object.keys(programmes[0]).sort()).toEqual(['id', 'name', 'role', 'schedule'])
  })

  it('copes with a card that has nothing, null lists or odd values', () => {
    expect(normalizeAppointments(null)).toEqual({ programmes: [], appointments: [] })
    expect(normalizeAppointments({})).toEqual({ programmes: [], appointments: [] })
    expect(normalizeAppointments({ appointments: null, meetingProgramParticipations: 'x' })).toEqual({ programmes: [], appointments: [] })

    const odd = normalizeAppointments({ appointments: [null, 5, { id: 'bare' }], meetingProgramParticipations: [null, {}] })
    expect(odd.appointments).toEqual([{ id: 'bare', type: null, startsOn: null, endsOn: null, subject: '', location: null, isOnline: false, table: null, notes: null, members: [] }])
    expect(odd.programmes).toEqual([])
  })
})
