/**
 * fiona/filmEvidence.js
 *
 * A Fiona person has the same name as a Strapi person the sync does not manage. Is it the same human? A film that both
 * are linked to says so: Fiona lists the films of a person (with the film's Fiona id and title), and a Strapi film is
 * credited to persons and carries the Fiona film id in `remoteId` as well as its titles. Same name and the same film
 * is the same person; the film is matched by id first and by title when no id matches.
 *
 * Pure: the Strapi side is handed in as `filmsOf(personId)`. No Nuxt auto-imports here so the module is unit-testable.
 */

const MIN_TITLE_LENGTH = 3
const asList = value => (Array.isArray(value) ? value : [])
const textOf = value => String(value ?? '').trim()

/** Lower case, no accents, punctuation as a single space: "Võõras: Öö!" and "vooras oo" are the same title. */
export function normalizeTitle (value) {
  return textOf(value)
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
}

const titlesOfStrapiFilm = film => [film.title_en, film.title_et, film.title_ru, film.titleOriginal].map(textOf).filter(Boolean)
const firstTitleOf = film => titlesOfStrapiFilm(film)[0] || null

/** How one Fiona film matches one Strapi film: 'id', 'title' or null. */
function matchOf (fionaFilm, strapiFilm) {
  const fionaId = textOf(fionaFilm.id)
  const remoteId = textOf(strapiFilm.remoteId)
  if (fionaId && remoteId && fionaId === remoteId) return 'id'
  const wanted = normalizeTitle(fionaFilm.title)
  if (wanted.length < MIN_TITLE_LENGTH) return null
  return titlesOfStrapiFilm(strapiFilm).some(title => normalizeTitle(title) === wanted) ? 'title' : null
}

/**
 * @param {{ fionaFilms: { id?: string, title?: string }[], candidates: { id: number }[], filmsOf: (personId: number) => object[] }} options
 *   filmsOf = the Strapi films a person is credited in
 * @returns {{ verdict: 'confirmed'|'ambiguous'|'unconfirmed'|'no-film', fionaFilmCount: number, candidateId?: number, by?: 'id'|'title', matches: object[] }}
 *   confirmed = exactly one candidate shares a film; ambiguous = several do; unconfirmed = the Fiona person has films and no
 *   candidate shares one; no-film = Fiona knows no film of the person, so there is nothing to compare
 */
export function assessSameName ({ fionaFilms, candidates, filmsOf }) {
  const films = asList(fionaFilms)
  if (!films.length) return { verdict: 'no-film', fionaFilmCount: 0, matches: [] }

  const matches = []
  for (const candidate of asList(candidates)) {
    for (const strapiFilm of asList(filmsOf(candidate.id))) {
      for (const fionaFilm of films) {
        const by = matchOf(fionaFilm, strapiFilm)
        if (!by) continue
        matches.push({
          candidateId: candidate.id,
          by,
          fionaFilm: { id: textOf(fionaFilm.id), title: textOf(fionaFilm.title) },
          strapiFilm: { id: strapiFilm.id, remoteId: strapiFilm.remoteId ?? null, title: firstTitleOf(strapiFilm) }
        })
      }
    }
  }
  const matchedIds = [...new Set(matches.map(match => match.candidateId))]
  if (!matchedIds.length) return { verdict: 'unconfirmed', fionaFilmCount: films.length, matches }
  if (matchedIds.length > 1) return { verdict: 'ambiguous', fionaFilmCount: films.length, matches }
  return {
    verdict: 'confirmed',
    fionaFilmCount: films.length,
    candidateId: matchedIds[0],
    by: matches.some(match => match.by === 'id') ? 'id' : 'title',
    matches
  }
}

/**
 * The films Fiona links to a person: those on the accreditations the sync works with and, when the client can read them,
 * those on the person itself (earlier editions too). Each film once; a source that fails is left out and logged.
 */
export async function collectFionaFilms ({ fiona, fionaPersonId, accreditationIds = [], log = console }) {
  const films = new Map()
  const add = (list) => {
    for (const film of asList(list)) {
      const key = textOf(film.id) || `title:${normalizeTitle(film.title)}`
      if (!films.has(key)) films.set(key, film)
    }
  }
  for (const accreditationId of accreditationIds) {
    try {
      add((await fiona.getAccreditation(accreditationId)).films)
    } catch (err) {
      log.warn?.(`[fiona films] accreditation ${accreditationId}: ${err?.message || err}`)
    }
  }
  if (typeof fiona.getPersonFilms === 'function') {
    try {
      add(await fiona.getPersonFilms(fionaPersonId))
    } catch (err) {
      log.warn?.(`[fiona films] person ${fionaPersonId}: ${err?.message || err}`)
    }
  }
  return [...films.values()]
}
