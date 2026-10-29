import { describe, it, expect } from 'vitest'
import { outlineFields, describeFionaFields } from '../server/utils/fiona/fieldDiagnostic.js'

const silent = { info () {}, warn () {}, error () {} }
const lookup = (key, text) => ({ key, translations: [{ language: 'en', text }, { language: 'et', text: `${text} (et)` }] })
const find = (fields, path) => fields.find(field => field.path === path)

describe('outlineFields', () => {
  it('lists every path with its type and shows the values of the fields we look for', () => {
    const fields = outlineFields({
      id: 'acc-1',
      person: {
        firstName: 'Mari',
        address: { street: 'Salapärane 1', country: lookup('estonia', 'Estonia') },
        companies: [{ name: 'Acme Films' }, { name: 'Beta Pictures' }]
      },
      occupation: 'Producer'
    })

    expect(find(fields, 'occupation')).toMatchObject({ type: 'string', values: ['Producer'] })
    expect(find(fields, 'person.address.country.key')).toMatchObject({ type: 'string', values: ['estonia'] })
    expect(find(fields, 'person.address.country.translations[].text')).toMatchObject({ values: ['Estonia', 'Estonia (et)'] })
    expect(find(fields, 'person.companies[]')).toMatchObject({ type: 'array', count: 2 })
    expect(find(fields, 'person.companies[].name')).toMatchObject({ values: ['Acme Films', 'Beta Pictures'] })
  })

  it('never shows the values of personal fields, only that they exist', () => {
    const fields = outlineFields({
      person: {
        firstName: 'Mari',
        contactDetails: [{ type: lookup('Email', 'Email'), value: 'mari@example.com' }],
        address: { street: 'Salapärane 1', postalCode: '10111' }
      }
    })

    expect(JSON.stringify(fields)).not.toMatch(/mari@example|Salapärane|10111|Mari/)
    expect(find(fields, 'person.firstName')).toEqual({ path: 'person.firstName', type: 'string' })
    expect(find(fields, 'person.contactDetails[].value')).toEqual({ path: 'person.contactDetails[].value', type: 'string' })
  })

  it('lists custom fields by their key and shows a value only when the key is one we look for', () => {
    const fields = outlineFields({
      customFieldValues: [
        { key: 'accreditation-general-current-occupation', value: 'Sales agent' },
        { key: 'accreditation-general-programme', value: 'Industry Pro' },
        { key: 'accreditation-general-Do_Not_Publish_email', value: true },
        { key: 'accreditation-general-delivered-by', value: '2026-10-28' }
      ]
    })

    expect(find(fields, 'customFieldValues[accreditation-general-current-occupation]')).toMatchObject({ type: 'string', values: ['Sales agent'] })
    expect(find(fields, 'customFieldValues[accreditation-general-programme]')).toMatchObject({ values: ['Industry Pro'] })
    expect(find(fields, 'customFieldValues[accreditation-general-Do_Not_Publish_email]')).toEqual({ path: 'customFieldValues[accreditation-general-Do_Not_Publish_email]', type: 'boolean' })
    expect(find(fields, 'customFieldValues[accreditation-general-delivered-by]')).toEqual({ path: 'customFieldValues[accreditation-general-delivered-by]', type: 'string' })
  })

  it('shortens long values and keeps at most five distinct examples', () => {
    const many = Array.from({ length: 9 }, (_, i) => ({ category: `Category ${i % 7}` }))
    const fields = outlineFields({ items: many, programme: 'x'.repeat(300) })

    expect(find(fields, 'items[].category').values).toHaveLength(5)
    expect(find(fields, 'programme').values[0].length).toBeLessThanOrEqual(81)
  })

  it('copes with null, empty arrays and scalars at the top', () => {
    expect(outlineFields(null)).toEqual([])
    expect(outlineFields({ person: null, films: [] })).toEqual([
      { path: 'films[]', type: 'array', count: 0 },
      { path: 'person', type: 'null' }
    ])
  })
})

describe('describeFionaFields', () => {
  const people = new Map([
    [10, { id: 10, firstName: 'Mari', lastName: 'Maasikas', fiona_person_id: 'fp-10', fiona_accreditation_id: 'acc-a,acc-b' }],
    [12, { id: 12, firstName: 'Hand', lastName: 'Made', fiona_person_id: null }]
  ])
  const strapi = { findPersonById: id => people.get(Number(id)) || null }
  const calls = []
  const reader = name => ({
    getRaw: (path) => {
      calls.push(`${name} ${path}`)
      if (path.includes('boom')) throw new Error('HTTP 500')
      return { id: path, occupation: 'Producer' }
    }
  })

  it('reads the person and each accreditation from both Fiona APIs and outlines them', async () => {
    calls.length = 0
    const result = await describeFionaFields({ personIds: [10], strapi, publication: reader('publication'), xapi: reader('xapi'), log: silent })

    expect(calls).toEqual([
      'publication /persons/fp-10',
      'publication /accreditations/acc-a',
      'publication /accreditations/acc-b',
      'xapi /person/fp-10',
      'xapi /accreditation/acc-a',
      'xapi /accreditation/acc-b'
    ])
    expect(result.persons).toHaveLength(1)
    expect(result.persons[0]).toMatchObject({ personId: 10, name: 'Mari Maasikas' })
    expect(result.persons[0].sources.map(source => source.source)).toEqual([
      'publication /persons/{personId}',
      'publication /accreditations/{id}',
      'publication /accreditations/{id}',
      'xapi /person/{personId}',
      'xapi /accreditation/{id}',
      'xapi /accreditation/{id}'
    ])
    expect(find(result.persons[0].sources[1].fields, 'occupation').values).toEqual(['Producer'])
  })

  it('works with one API only', async () => {
    const result = await describeFionaFields({ personIds: [10], strapi, publication: reader('publication'), xapi: null, log: silent })

    expect(result.persons[0].sources.every(source => source.source.startsWith('publication'))).toBe(true)
  })

  it('reports a failing read as an error of that source and carries on', async () => {
    const failing = { getRaw: (path) => { if (path.startsWith('/persons')) throw new Error('HTTP 404'); return { occupation: 'Producer' } } }

    const result = await describeFionaFields({ personIds: [10], strapi, publication: failing, xapi: null, log: silent })

    expect(result.persons[0].sources[0]).toEqual({ source: 'publication /persons/{personId}', error: 'HTTP 404' })
    expect(result.persons[0].sources[1].fields).toBeDefined()
  })

  it('skips persons the sync does not manage and says so', async () => {
    const result = await describeFionaFields({ personIds: [12, 99], strapi, publication: reader('publication'), xapi: null, log: silent })

    expect(result.persons).toEqual([])
    expect(result.skipped).toEqual([{ personId: 12, reason: 'not managed by the Fiona sync' }, { personId: 99, reason: 'not found' }])
  })

  it('refuses more than 5 persons and an empty list', async () => {
    await expect(describeFionaFields({ personIds: [], strapi, publication: reader('publication'), log: silent })).rejects.toThrow(/personIds/)
    await expect(describeFionaFields({ personIds: [1, 2, 3, 4, 5, 6], strapi, publication: reader('publication'), log: silent })).rejects.toThrow(/at most 5/)
  })
})
