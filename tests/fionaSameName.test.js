import { describe, it, expect } from 'vitest'
import { findSameNamePersons, describeCandidate } from '../server/utils/fiona/sameName.js'

function fakeStrapi (people) {
  const queries = []
  return {
    queries,
    findPeopleByNameTerm: (term) => {
      queries.push(term)
      const wanted = String(term).toLowerCase()
      return people.filter(p => String(p.firstNameLastName || '').toLowerCase().includes(wanted) || String(p.lastName || '').toLowerCase().includes(wanted))
    }
  }
}

const person = (id, name, extra = {}) => ({ id, firstName: name.split(' ')[0], lastName: name.split(' ').slice(1).join(' '), firstNameLastName: name, fiona_person_id: null, ...extra })

describe('findSameNamePersons', () => {
  it('finds persons with the same name whatever the case, accents or punctuation, and none that the sync manages already', async () => {
    const strapi = fakeStrapi([
      person(20, 'Mari Maasikas'),
      person(21, 'MARI  maasikas'),
      person(22, 'Mari Maasikas', { fiona_person_id: 'other-fiona-person' }),
      person(23, 'Marit Maasikas'),
      person(24, 'Kati Kask')
    ])

    const found = await findSameNamePersons({ strapi, firstName: 'Mari', lastName: 'Maasikas' })

    expect(found.map(p => p.id)).toEqual([20, 21])
  })

  it('also finds a person whose name has accents when Fiona spells it without (and the other way round)', async () => {
    const strapi = fakeStrapi([person(30, 'Kaie Sõber'), person(31, 'Kaie Sober')])

    const found = await findSameNamePersons({ strapi, firstName: 'Kaie', lastName: 'Sõber' })

    expect(found.map(p => p.id)).toEqual([30, 31])
    expect(strapi.queries).toEqual(['Sõber', 'sober'])
  })

  it('lists a person once even when two search words find it, lowest id first', async () => {
    const strapi = fakeStrapi([person(41, 'Kaie Sõber'), person(40, 'Kaie Sõber')])

    const found = await findSameNamePersons({ strapi, firstName: 'Kaie', lastName: 'Sõber' })

    expect(found.map(p => p.id)).toEqual([40, 41])
  })

  it('finds nobody, and asks nothing, for a name too short or empty to search for', async () => {
    const strapi = fakeStrapi([person(50, 'Li')])

    expect(await findSameNamePersons({ strapi, firstName: '', lastName: '' })).toEqual([])
    expect(await findSameNamePersons({ strapi, firstName: 'Li', lastName: '' })).toEqual([])
    expect(strapi.queries).toEqual([])
  })
})

describe('describeCandidate', () => {
  it('gives the few facts a person needs to decide: who, e-mail, login, Eventival id, picture', () => {
    const slim = describeCandidate({ id: 7, firstNameLastName: 'Mari Maasikas', eMail: ' m@x.ee ', user: { id: 70 }, remoteId: '991', picture: { id: 1 }, public: true, ignored: 'x' })
    expect(slim).toEqual({ id: 7, name: 'Mari Maasikas', email: 'm@x.ee', userId: 70, remoteId: '991', hasPicture: true, public: true })
  })
})
