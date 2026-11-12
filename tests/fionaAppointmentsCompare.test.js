/**
 * compareAppointmentLists — the live appointments (XAPI) against the published ones (card), appointment by appointment:
 * which exist on one side only and, for those on both, which fields differ. By default only the field names are reported;
 * with showValues the two values are shown too (for a person's own check).
 */
import { describe, it, expect } from 'vitest'
import { compareAppointmentLists } from '../server/utils/fiona/appointmentsCompare.js'

const member = (name, roleText = null) => ({ id: null, name, role: roleText ? { key: roleText.toLowerCase(), text: roleText } : null, personId: null, isMe: false })

const appt = (id, overrides = {}) => ({
  id,
  type: { key: 'interview', text: 'Interview', abbreviation: null },
  startsOn: '2026-11-12T06:00:00.000Z',
  endsOn: '2026-11-12T06:15:00.000Z',
  subject: `TEST ${id}`,
  location: 'Cuba Films office',
  isOnline: false,
  table: null,
  notes: null,
  members: [member('Jaan Leppik'), member('Ingel Iris Tofert', 'Industry representative')],
  ...overrides
})

describe('compareAppointmentLists', () => {
  it('counts appointments that are the same on both sides', () => {
    const result = compareAppointmentLists([appt('a'), appt('b')], [appt('b'), appt('a')])

    expect(result).toEqual({ live: 2, published: 2, same: 2, onlyInLive: [], onlyInPublished: [], different: [] })
  })

  it('lists, by id, the appointments that exist on one side only', () => {
    const result = compareAppointmentLists([appt('a'), appt('new'), appt('c')], [appt('a'), appt('gone'), appt('c')])

    expect(result).toMatchObject({ live: 3, published: 3, same: 2, onlyInLive: ['new'], onlyInPublished: ['gone'], different: [] })
  })

  it('names the fields that differ, without their values unless asked', () => {
    const live = [appt('a', { subject: 'TEST new subject', location: 'Iglupark' })]
    const published = [appt('a')]

    expect(compareAppointmentLists(live, published).different).toEqual([{ id: 'a', fields: ['subject', 'location'] }])
    expect(compareAppointmentLists(live, published, { showValues: true }).different).toEqual([{
      id: 'a',
      fields: ['subject', 'location'],
      values: { subject: { live: 'TEST new subject', published: 'TEST a' }, location: { live: 'Iglupark', published: 'Cuba Films office' } }
    }])
  })

  it('compares times as moments, not as text', () => {
    const live = [appt('a', { startsOn: '2026-11-12T08:00:00+02:00', endsOn: '2026-11-12T06:15:00Z' })]

    expect(compareAppointmentLists(live, [appt('a')])).toMatchObject({ same: 1, different: [] })
    expect(compareAppointmentLists([appt('a', { startsOn: '2026-11-12T06:30:00.000Z' })], [appt('a')]).different).toEqual([{ id: 'a', fields: ['startsOn'] }])
  })

  it('compares the type by its text, ignoring case, and treats no type like no type', () => {
    const lower = appt('a', { type: { key: 'x-different-key', text: 'interview', abbreviation: null } })

    expect(compareAppointmentLists([lower], [appt('a')]).same).toBe(1)
    expect(compareAppointmentLists([appt('a', { type: null })], [appt('a', { type: null })]).same).toBe(1)
    expect(compareAppointmentLists([appt('a', { type: null })], [appt('a')]).different).toEqual([{ id: 'a', fields: ['type'] }])
  })

  it('compares the people in it by name and role, whatever their order, case and the ids and links they carry', () => {
    const live = [appt('a', { members: [member('INGEL iris tofert', 'Industry representative'), member('Jaan  Leppik')] })]
    const published = [appt('a', { members: [{ ...member('Jaan Leppik'), personId: 'p-1', isMe: true }, { ...member('Ingel Iris Tofert', 'Industry representative'), personId: 'p-2' }] })]

    expect(compareAppointmentLists(live, published)).toMatchObject({ same: 1, different: [] })
  })

  it('reports members when someone is missing or has another role, and shows them only when asked', () => {
    const live = [appt('a', { members: [member('Jaan Leppik'), member('Ingel Iris Tofert', 'Film maker')] })]
    const published = [appt('a')]

    expect(compareAppointmentLists(live, published).different).toEqual([{ id: 'a', fields: ['members'] }])
    expect(compareAppointmentLists(live, published, { showValues: true }).different[0].values.members).toEqual({
      live: ['ingel iris tofert | film maker', 'jaan leppik'],
      published: ['ingel iris tofert | industry representative', 'jaan leppik']
    })
  })

  it('treats a table, a location and an online flag that are the same as same, and different ones as different', () => {
    const live = [appt('a', { table: 'Table 4', isOnline: true })]

    expect(compareAppointmentLists(live, [appt('a')]).different).toEqual([{ id: 'a', fields: ['isOnline', 'table'] }])
  })

  it('copes with empty and malformed lists', () => {
    expect(compareAppointmentLists([], [])).toEqual({ live: 0, published: 0, same: 0, onlyInLive: [], onlyInPublished: [], different: [] })
    expect(compareAppointmentLists(null, undefined)).toEqual({ live: 0, published: 0, same: 0, onlyInLive: [], onlyInPublished: [], different: [] })
    expect(compareAppointmentLists([null, { id: null }], [])).toMatchObject({ live: 2 })
  })
})
