import { describe, it, expect } from 'vitest'
import { normalizeTitle, assessSameName, collectFionaFilms } from '../server/utils/fiona/filmEvidence.js'

const strapiFilm = (over = {}) => ({ id: 1, remoteId: 'film-guid-1', title_en: 'The Fish', title_et: 'Kala', title_ru: null, titleOriginal: 'Fisk', ...over })
const fionaFilm = (over = {}) => ({ id: 'film-guid-1', title: 'The Fish', editionId: 'e1', roles: ['Director'], ...over })
const candidate = id => ({ id, name: 'Mari Maasikas' })
const filmsOfPerson = byPerson => personId => byPerson[personId] || []

describe('normalizeTitle', () => {
  it('ignores letter case, accents, punctuation and spacing', () => {
    expect(normalizeTitle('  The  Fish! ')).toBe('the fish')
    expect(normalizeTitle('Võõras: Öö')).toBe('vooras oo')
    expect(normalizeTitle('Ça va?')).toBe('ca va')
  })

  it('gives an empty string for nothing', () => {
    expect(normalizeTitle(null)).toBe('')
    expect(normalizeTitle(undefined)).toBe('')
    expect(normalizeTitle('   ')).toBe('')
  })
})

describe('assessSameName: is the same-name Strapi person the Fiona person, judged by a shared film', () => {
  it('confirms a candidate whose film has the Fiona film id as remoteId', () => {
    const result = assessSameName({
      fionaFilms: [fionaFilm({ title: 'Something else entirely' })],
      candidates: [candidate(20)],
      filmsOf: filmsOfPerson({ 20: [strapiFilm()] })
    })

    expect(result).toMatchObject({ verdict: 'confirmed', candidateId: 20, by: 'id', fionaFilmCount: 1 })
    expect(result.matches).toEqual([{ candidateId: 20, by: 'id', fionaFilm: { id: 'film-guid-1', title: 'Something else entirely' }, strapiFilm: { id: 1, remoteId: 'film-guid-1', title: 'The Fish' } }])
  })

  it('confirms by title when no id matches: any of the Estonian, English, Russian or original title, ignoring case and accents', () => {
    const base = { candidates: [candidate(20)], filmsOf: filmsOfPerson({ 20: [strapiFilm({ remoteId: 'eventival-77' })] }) }

    expect(assessSameName({ ...base, fionaFilms: [fionaFilm({ id: 'other', title: 'KALA' })] })).toMatchObject({ verdict: 'confirmed', candidateId: 20, by: 'title' })
    expect(assessSameName({ ...base, fionaFilms: [fionaFilm({ id: 'other', title: 'fisk' })] })).toMatchObject({ verdict: 'confirmed', by: 'title' })
    expect(assessSameName({ ...base, fionaFilms: [fionaFilm({ id: 'other', title: 'the  fish' })] })).toMatchObject({ verdict: 'confirmed', by: 'title' })
  })

  it('says "id" when a candidate matches by id and by title', () => {
    const result = assessSameName({ fionaFilms: [fionaFilm()], candidates: [candidate(20)], filmsOf: filmsOfPerson({ 20: [strapiFilm()] }) })

    expect(result.by).toBe('id')
  })

  it('does not match on a title shorter than three characters or on empty titles', () => {
    const result = assessSameName({
      fionaFilms: [fionaFilm({ id: 'other', title: 'Ab' }), fionaFilm({ id: 'x', title: '' })],
      candidates: [candidate(20)],
      filmsOf: filmsOfPerson({ 20: [strapiFilm({ remoteId: null, title_en: 'Ab', title_et: '', titleOriginal: null })] })
    })

    expect(result.verdict).toBe('unconfirmed')
  })

  it('is unconfirmed when the Fiona person has films and no candidate shares one', () => {
    const result = assessSameName({
      fionaFilms: [fionaFilm({ id: 'other', title: 'Another film' })],
      candidates: [candidate(20), candidate(21)],
      filmsOf: filmsOfPerson({ 20: [strapiFilm()], 21: [] })
    })

    expect(result).toMatchObject({ verdict: 'unconfirmed', fionaFilmCount: 1, matches: [] })
    expect(result.candidateId).toBeUndefined()
  })

  it('has "no-film" when Fiona knows no film of the person: nothing to compare', () => {
    const result = assessSameName({ fionaFilms: [], candidates: [candidate(20)], filmsOf: filmsOfPerson({ 20: [strapiFilm()] }) })

    expect(result).toMatchObject({ verdict: 'no-film', fionaFilmCount: 0, matches: [] })
  })

  it('is ambiguous when more than one candidate shares a film: the sync must not choose', () => {
    const result = assessSameName({
      fionaFilms: [fionaFilm()],
      candidates: [candidate(20), candidate(21)],
      filmsOf: filmsOfPerson({ 20: [strapiFilm()], 21: [strapiFilm({ id: 2 })] })
    })

    expect(result).toMatchObject({ verdict: 'ambiguous' })
    expect(result.matches.map(match => match.candidateId)).toEqual([20, 21])
    expect(result.candidateId).toBeUndefined()
  })

  it('confirms the one candidate that shares a film while another has none', () => {
    const result = assessSameName({
      fionaFilms: [fionaFilm()],
      candidates: [candidate(20), candidate(21)],
      filmsOf: filmsOfPerson({ 20: [], 21: [strapiFilm()] })
    })

    expect(result).toMatchObject({ verdict: 'confirmed', candidateId: 21 })
  })

  it('reports one match per candidate even when several films match', () => {
    const result = assessSameName({
      fionaFilms: [fionaFilm(), fionaFilm({ id: 'g2', title: 'Second' })],
      candidates: [candidate(20)],
      filmsOf: filmsOfPerson({ 20: [strapiFilm(), strapiFilm({ id: 2, remoteId: 'g2', title_en: 'Second' })] })
    })

    expect(result.verdict).toBe('confirmed')
    expect(result.matches).toHaveLength(2)
    expect(result.candidateId).toBe(20)
  })

  it('does not let a film with no remoteId match a Fiona film without an id', () => {
    const result = assessSameName({
      fionaFilms: [fionaFilm({ id: '', title: 'Unrelated' })],
      candidates: [candidate(20)],
      filmsOf: filmsOfPerson({ 20: [strapiFilm({ remoteId: '' })] })
    })

    expect(result.verdict).toBe('unconfirmed')
  })
})

describe('collectFionaFilms: the films Fiona links to a person', () => {
  const accreditationFilm = { id: 'a-film', title: 'Accred film', editionId: 'e1', roles: ['Producer'] }
  const personFilm = { id: 'p-film', title: 'Person film', editionId: 'e0', roles: ['Director'] }
  const fakeFiona = ({ accreditations = {}, personFilms = null, failAccreditation = null } = {}) => ({
    getAccreditation: (id) => {
      if (id === failAccreditation) return Promise.reject(new Error('HTTP 502'))
      return Promise.resolve({ films: accreditations[id] || [] })
    },
    ...(personFilms ? { getPersonFilms: () => Promise.resolve(personFilms) } : {})
  })
  const log = { warns: [], warn (message) { this.warns.push(message) } }

  it('puts the films of the accreditations and of the person together, each film once', async () => {
    const films = await collectFionaFilms({
      fiona: fakeFiona({ accreditations: { acc1: [accreditationFilm], acc2: [accreditationFilm] }, personFilms: [personFilm, accreditationFilm] }),
      fionaPersonId: 'fp1',
      accreditationIds: ['acc1', 'acc2'],
      log
    })

    expect(films.map(film => film.id)).toEqual(['a-film', 'p-film'])
  })

  it('works with a client that has no person-level films', async () => {
    const films = await collectFionaFilms({ fiona: fakeFiona({ accreditations: { acc1: [accreditationFilm] } }), fionaPersonId: 'fp1', accreditationIds: ['acc1'], log })

    expect(films).toEqual([accreditationFilm])
  })

  it('keeps what it could read when one source fails, and says so', async () => {
    const logger = { warns: [], warn (message) { this.warns.push(message) } }
    const films = await collectFionaFilms({
      fiona: fakeFiona({ accreditations: { acc2: [accreditationFilm] }, personFilms: [personFilm], failAccreditation: 'acc1' }),
      fionaPersonId: 'fp1',
      accreditationIds: ['acc1', 'acc2'],
      log: logger
    })

    expect(films.map(film => film.id)).toEqual(['a-film', 'p-film'])
    expect(logger.warns.some(line => line.includes('acc1') && line.includes('502'))).toBe(true)
  })
})
