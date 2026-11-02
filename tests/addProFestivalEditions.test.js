/**
 * The Creative Gate profile form (person and organisation) only offers the festival editions marked use_in_cg, and a save
 * writes the submitted list over the whole relation. So an edition the form does not offer (the Industry@Tallinn edition the
 * Fiona sync attached, one an editor gave) was dropped by the next save of the profile. These tests keep it.
 * $fetch is globally mocked in setup.js.
 */
import { describe, it, expect, vi } from 'vitest'
import jwt from 'jsonwebtoken'
import { keepEditionsTheFormDoesNotOffer } from '../server/utils/addpro/festivalEditions.js'
import { getStrapiCgEditionIds } from '../server/utils/strapi.js'

describe('keepEditionsTheFormDoesNotOffer', () => {
  const OFFERED = [113, 120] // the form's use_in_cg editions

  it('keeps the editions the form does not offer when a save changes what the form offers (the Emma case)', () => {
    // she holds Creative Gate 59 and the sync's Industry@Tallinn 114, and picks Berlinale 113 in the form
    const merged = keepEditionsTheFormDoesNotOffer({ submitted: [113], original: [59, 114], offered: OFFERED })

    expect(merged).toEqual([113, 59, 114])
  })

  it('still lets the person untick an edition the form offers', () => {
    const merged = keepEditionsTheFormDoesNotOffer({ submitted: [], original: [59, 113, 114], offered: OFFERED })

    expect(merged).toEqual([59, 114])
  })

  it('lets the person add and drop offered editions in one save, keeping the rest', () => {
    const merged = keepEditionsTheFormDoesNotOffer({ submitted: [120], original: [59, 113, 114], offered: OFFERED })

    expect(merged).toEqual([120, 59, 114])
  })

  it('does not double an edition and reads ids given as text or as relation objects', () => {
    const merged = keepEditionsTheFormDoesNotOffer({ submitted: ['113', 59], original: [{ id: 59 }, { id: 114 }, '113'], offered: OFFERED })

    expect(merged).toEqual([113, 59, 114])
  })

  it('never drops an edition when it is not known what the form offers (the lookup failed)', () => {
    const merged = keepEditionsTheFormDoesNotOffer({ submitted: [120], original: [59, 113, 114], offered: null })

    expect(merged).toEqual([120, 59, 113, 114])
  })

  it('has nothing to keep for a person without editions', () => {
    expect(keepEditionsTheFormDoesNotOffer({ submitted: [113], original: [], offered: OFFERED })).toEqual([113])
    expect(keepEditionsTheFormDoesNotOffer({ submitted: [113], original: undefined, offered: OFFERED })).toEqual([113])
  })

  it('ignores values that are no ids', () => {
    expect(keepEditionsTheFormDoesNotOffer({ submitted: [113, 'x', null], original: [59, NaN], offered: OFFERED })).toEqual([113, 59])
  })
})

describe('getStrapiCgEditionIds', () => {
  const TOKEN = jwt.sign({ id: 16998 }, 'test-secret', { expiresIn: '1h' })

  it('asks Strapi for the editions marked use_in_cg, all of them, and returns their ids', async () => {
    globalThis.$fetch = vi.fn().mockImplementation((url) => {
      if (url.endsWith('/auth/local')) return { jwt: TOKEN }
      if (url.includes('/festival-editions')) return [{ id: 113, name_en: 'Berlinale 2026' }, { id: 120 }]
      throw new Error(`unexpected ${url}`)
    })

    const ids = await getStrapiCgEditionIds()

    expect(ids).toEqual([113, 120])
    const asked = globalThis.$fetch.mock.calls.map(([url]) => url).find(url => url.includes('/festival-editions'))
    expect(asked).toContain('use_in_cg=true')
    expect(asked).toContain('_limit=-1')
  })

  it('passes a Strapi error on, so the caller can choose not to drop anything', async () => {
    globalThis.$fetch = vi.fn().mockImplementation((url) => {
      if (url.endsWith('/auth/local')) return { jwt: TOKEN }
      throw new Error('HTTP 500')
    })

    await expect(getStrapiCgEditionIds()).rejects.toThrow(/500/)
  })
})

describe('the profile form save (getAddProPersonPostData / getAddProOrganisationPostData)', () => {
  // the Nuxt auto-imports the module relies on
  const setup = (offered) => {
    globalThis.simplifyPersonCollection = person => Promise.resolve(person)
    globalThis.simplifyOrganisationCollection = organisation => Promise.resolve(organisation)
    globalThis.getStrapiCgEditionIds = vi.fn(() => (offered instanceof Error ? Promise.reject(offered) : Promise.resolve(offered)))
  }
  // the person as simplifyPersonCollection returns it (lists as lists), and the form as the browser sends it
  const lists = { other_lang: [], tag_looking_fors: [], orderedRaF: [], images: [] }
  const person = editions => ({ id: 40141, firstName: 'Emma', lastName: 'Grape', slug_en: 'emma-grape', addr_coll: null, ...lists, festival_editions: editions })
  const form = editions => ({ firstName: 'Emma', lastName: 'Grape', addr_coll: {}, ...lists, festival_editions: editions })
  const post = async (originalEditions, formEditions, builder = 'person') => {
    const mod = await import('../server/utils/addpro/addProPostData.js')
    return builder === 'person'
      ? await mod.getAddProPersonPostData(form(formEditions), person(originalEditions), {})
      : await mod.getAddProOrganisationPostData({ name_en: 'Acme', people: [], languages: [], ...form(formEditions) }, { id: 7, name_en: 'Acme', slug_en: 'acme', addr_coll: null, ...lists, people: [], languages: [], festival_editions: originalEditions }, {})
  }

  it('keeps the edition the sync attached (114) when she saves her profile with Berlinale ticked', async () => {
    setup([113])

    const posted = await post([59, 114], ['113'])

    expect(posted.festival_editions).toEqual([113, 59, 114])
  })

  it('lets her untick an edition the form offers, and keeps the others', async () => {
    setup([113])

    const posted = await post([59, 113, 114], [])

    expect(posted.festival_editions).toEqual([59, 114])
  })

  it('sends the person\'s editions unchanged (and asks Strapi nothing) when the form did not change the list', async () => {
    setup([113])

    const posted = await post([59, 114], ['59', '114'])

    expect(posted.festival_editions).toEqual([59, 114])
    expect(globalThis.getStrapiCgEditionIds).not.toHaveBeenCalled()
  })

  it('still puts Creative Gate (59) on a person who lacks it', async () => {
    setup([113])

    const posted = await post([114], ['113'])

    expect(posted.festival_editions).toEqual([113, 114, 59])
  })

  it('drops nothing when Strapi cannot say which editions the form offers', async () => {
    setup(new Error('HTTP 500'))

    const posted = await post([59, 113, 114], ['120'])

    expect(posted.festival_editions).toEqual([120, 59, 113, 114])
  })

  it('does the same for an organisation profile', async () => {
    setup([113])

    const posted = await post([59, 114], ['113'], 'organisation')

    expect(posted.festival_editions).toEqual([113, 59, 114])
  })
})
