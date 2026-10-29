import { describe, it, expect } from 'vitest'
import { normalizeName, splitOccupations, planCategories, planRoles, planCountry, uniqueNames, isPlaceholderCompany } from '../server/utils/fiona/extraFields.js'

describe('normalizeName', () => {
  it('ignores case, accents, punctuation and spacing', () => {
    expect(normalizeName('  Black  Nights Stars ')).toBe('black nights stars')
    expect(normalizeName('Breaking Into the Industry')).toBe(normalizeName('Breaking into the Industry'))
    expect(normalizeName('Tõnis Pill')).toBe('tonis pill')
    expect(normalizeName('in.kind')).toBe(normalizeName('IN KIND'))
    expect(normalizeName(null)).toBe('')
  })
})

describe('uniqueNames', () => {
  it('keeps the first spelling of each name, in order, without empty ones', () => {
    expect(uniqueNames(['In.Kind', ' ', null, 'in kind', 'IMAGO TC'])).toEqual(['In.Kind', 'IMAGO TC'])
  })
})

describe('isPlaceholderCompany', () => {
  it('recognises the words people type when they have no company', () => {
    for (const word of ['N/A', 'n.a.', 'None', '-', 'Freelance', 'freelancer', 'Self-employed', 'Independent', 'unemployed', 'TBD', 'no company']) expect(isPlaceholderCompany(word), word).toBe(true)
  })

  it('does not mistake a real company for one', () => {
    for (const name of ['IMAGO TC', 'in.kind', 'Freelance Films OÜ', 'Independent Pictures']) expect(isPlaceholderCompany(name), name).toBe(false)
  })
})

describe('splitOccupations', () => {
  it('splits the free text of "Current occupation" at commas, semicolons, slashes and line breaks', () => {
    expect(splitOccupations('Producer, Production manager')).toEqual(['Producer', 'Production manager'])
    expect(splitOccupations('Director / Screenwriter; Editor\nComposer')).toEqual(['Director', 'Screenwriter', 'Editor', 'Composer'])
    expect(splitOccupations('')).toEqual([])
    expect(splitOccupations(null)).toEqual([])
  })
})

describe('planCategories', () => {
  const strapiCategories = [{ id: 1, name: 'Discovery Campus' }, { id: 2, name: 'Black Nights Stars' }, { id: 3, name: 'Breaking into the Industry' }]

  it('matches Fiona labels to Strapi industry categories by normalised name and keeps the ones the person has', () => {
    const plan = planCategories({ labels: ['Discovery Campus', 'Breaking Into the Industry'], strapiCategories, existingIds: [2] })

    expect(plan.ids).toEqual([2, 1, 3])
    expect(plan.added).toEqual(['Discovery Campus', 'Breaking into the Industry'])
    expect(plan.unmatched).toEqual([])
  })

  it('returns no ids when everything is there already, so nothing is written', () => {
    expect(planCategories({ labels: ['Discovery Campus'], strapiCategories, existingIds: [1, 2] }).ids).toBeNull()
  })

  it('reports labels Strapi does not know and creates nothing', () => {
    const plan = planCategories({ labels: ['Discovery Campus', 'Brand New Programme'], strapiCategories, existingIds: [] })

    expect(plan.ids).toEqual([1])
    expect(plan.unmatched).toEqual(['Brand New Programme'])
  })
})

describe('planRoles', () => {
  const strapiRoles = [
    { id: 11, order: 5, names: ['Producer', 'Produtsent'] },
    { id: 12, order: 6, names: ['Production manager'] },
    { id: 13, order: 7, names: ['Cinematographer'] }
  ]

  it('adds matching roles at the end of the ordered roles and keeps the existing rows with their ids', () => {
    const existingRows = [{ id: 900, order: 3, role_at_film: { id: 13 } }]

    const plan = planRoles({ occupations: ['producer', 'Production Manager'], strapiRoles, existingRows })

    expect(plan.rows).toEqual([
      { id: 900, order: 3, role_at_film: 13 },
      { order: 4, role_at_film: 11 },
      { order: 5, role_at_film: 12 }
    ])
    expect(plan.added).toEqual(['Producer', 'Production manager'])
    expect(plan.unmatched).toEqual([])
  })

  it('sends a row without a role back as it is, not as role 0', () => {
    const plan = planRoles({ occupations: ['Producer'], strapiRoles, existingRows: [{ id: 5, order: 1, role_at_film: null }] })

    expect(plan.rows).toEqual([{ id: 5, order: 1, role_at_film: null }, { order: 2, role_at_film: 11 }])
  })

  it('matches on any language name of the role', () => {
    expect(planRoles({ occupations: ['Produtsent'], strapiRoles, existingRows: [] }).rows).toEqual([{ order: 1, role_at_film: 11 }])
  })

  it('only matches roles that already exist (whitelist): the rest is reported, never created', () => {
    const plan = planRoles({ occupations: ['Producer', 'Chief dreamer'], strapiRoles, existingRows: [] })

    expect(plan.rows).toEqual([{ order: 1, role_at_film: 11 }])
    expect(plan.unmatched).toEqual(['Chief dreamer'])
  })

  it('writes nothing when the person has the roles already', () => {
    const plan = planRoles({ occupations: ['Producer'], strapiRoles, existingRows: [{ id: 1, order: 1, role_at_film: 11 }] })

    expect(plan.rows).toBeNull()
    expect(plan.added).toEqual([])
  })
})

describe('planCountry', () => {
  const strapiCountries = [{ id: 7, name_en: 'Poland' }, { id: 8, name_en: 'France' }, { id: 9, name_en: 'Czechia' }]

  it('finds the Strapi country by its English name', () => {
    expect(planCountry({ country: { id: 'poland', name: 'Poland' }, strapiCountries })).toEqual({ id: 7, unmatched: null })
  })

  it('reports a country Strapi does not know', () => {
    expect(planCountry({ country: { id: 'czech-republic', name: 'Czech Republic' }, strapiCountries })).toEqual({ id: null, unmatched: 'Czech Republic' })
  })

  it('does nothing without a country', () => {
    expect(planCountry({ country: null, strapiCountries })).toEqual({ id: null, unmatched: null })
  })
})
