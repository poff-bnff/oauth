/**
 * fiona/linkAudit.js
 *
 * Read-only probe (mode `links` of POST /api/sync/fiona): for the Fiona persons the sync manages, does Fiona still hold the
 * MyPoff login link, and does it still point at the login Strapi knows for that person?
 *
 * The link is made and kept by Fiona itself: its backend pulls the Strapi user id and e-mail from hunt when somebody signs in
 * with MyPoff, and stores it as the person's external authentication (GET /person/{id}/MyPoff/externalauthentications, the id
 * in `externalIdentification`). hunt never writes to Fiona, so this probe only READS (Fiona and Strapi) and answers with ids
 * and categories: no names, e-mails or contact details.
 *
 * Categories (one per person):
 *   linked-ok                  Fiona's link is the person's login, or the main login of it when the person's login is an alias
 *   linked-to-alias            the link is a login that is an alias of another: at the next sign-in hunt answers Fiona with the
 *                              main login, so the stored id no longer matches what Fiona is told
 *   linked-to-missing-user     the link is a Strapi user that does not exist (any more)
 *   linked-other-user          the link is a login that is not the person's own, nor its main login
 *   linked-person-has-no-user  Fiona has a link, but the Strapi person has no login
 *   unlinked-repairable        Fiona has no link, the Strapi person has a login (`repairUserId` = the main login of it)
 *   unlinked-no-user           Fiona has no link and the Strapi person has no login
 *   fiona-error / strapi-error a read failed: nothing is concluded (a failed read is never "unlinked")
 * Fiona's answer to a person without a link is told apart in `fionaAnswer`: `empty` (an empty list) or `status-<code>` (400/404).
 *
 * No Nuxt auto-imports here so the module is unit-testable.
 */

const PROVIDER = 'MyPoff'
const MAX_PERSONS = 100
const DEFAULT_LIMIT = 50
const NO_LINK_STATUSES = new Set([400, 404])

const relationId = value => (value && typeof value === 'object' ? value.id : value)
const usableId = value => value !== null && value !== undefined && String(value).trim() !== '' && Number(value) > 0
const statusOf = err => err?.statusCode ?? err?.status ?? err?.response?.status
const shortMessage = err => String(err?.message || err).slice(0, 200)

/**
 * The MyPoff links Fiona holds for a person: { linkIds, answer } (`answer` = 'empty' for an empty list, 'status-400' / 'status-404' when
 * Fiona answers that it holds none: measured 2026-11-19, a person without a link answers 404 Not Found) or { error } when the read failed
 * (a failed read is never "no link"). Read only.
 */
export async function readMyPoffLinks (xapi, fionaPersonId) {
  try {
    const answer = await xapi.getRaw(`/person/${encodeURIComponent(fionaPersonId)}/${PROVIDER}/externalauthentications`)
    const entries = Array.isArray(answer) ? answer : []
    const linkIds = [...new Set(entries.map(entry => entry?.externalIdentification ?? entry?.ExternalIdentification).filter(usableId).map(value => String(value).trim()))]
    return { linkIds, answer: 'empty' }
  } catch (err) {
    const status = statusOf(err)
    if (NO_LINK_STATUSES.has(status)) return { linkIds: [], answer: `status-${status}` }
    return { error: shortMessage(err) }
  }
}

/**
 * @param {{ personIds?: number[], offset?: number, limit?: number, strapi: object, xapi: object, log?: object }} options
 *   personIds = Strapi person ids (at most 100); otherwise the managed persons, lowest id first, `limit` (at most 100) from `offset`
 *   strapi needs findPersonById, countManagedPeople, findManagedPeoplePage and getUser; xapi needs getRaw
 */
export async function linkAudit ({ personIds = [], offset = 0, limit = DEFAULT_LIMIT, strapi, xapi, log = console } = {}) {
  const requested = [...new Set((Array.isArray(personIds) ? personIds : []).map(Number).filter(id => Number.isInteger(id) && id > 0))]
  if (requested.length > MAX_PERSONS) throw new Error(`links handles at most ${MAX_PERSONS} persons per call`)
  const pageSize = Number.isInteger(Number(limit)) && Number(limit) > 0 ? Number(limit) : DEFAULT_LIMIT
  if (pageSize > MAX_PERSONS) throw new Error(`links reads at most ${MAX_PERSONS} persons per call`)
  const start = Number.isInteger(Number(offset)) && Number(offset) > 0 ? Number(offset) : 0

  const skipped = []
  let people
  let total
  let nextOffset = null
  if (requested.length) {
    people = []
    for (const id of requested) {
      const found = await strapi.findPersonById(id)
      if (!found) skipped.push({ personId: id, reason: 'not found' })
      else if (!found.fiona_person_id) skipped.push({ personId: id, reason: 'not managed by the Fiona sync' })
      else people.push(found)
    }
    total = requested.length
  } else {
    total = Number(await strapi.countManagedPeople()) || 0
    people = await strapi.findManagedPeoplePage(start, pageSize)
    if (start + pageSize < total) nextOffset = start + pageSize
  }

  // a login is read once, however many persons share it
  const users = new Map()
  const userOf = (id) => {
    const key = String(id)
    if (!users.has(key)) users.set(key, Promise.resolve(strapi.getUser(id)))
    return users.get(key)
  }
  // the login an identity stands for: the main login of an alias, else the login itself
  const groupOf = (user, fallbackId) => Number(relationId(user?.mainUser)) || Number(user?.id) || Number(fallbackId)

  const counts = {}
  const listed = []
  let multipleLinks = 0

  for (const person of people) {
    const base = { personId: Number(person.id), fionaPersonId: String(person.fiona_person_id) }
    const personUserId = usableId(relationId(person.user)) ? Number(relationId(person.user)) : null
    let item
    try {
      item = await classify({ person, base, personUserId })
    } catch (err) {
      log.warn?.(`[fiona links] person #${person.id}: ${shortMessage(err)}`)
      item = { ...base, category: 'strapi-error', error: shortMessage(err) }
    }
    counts[item.category] = (counts[item.category] || 0) + 1
    if (item.category !== 'linked-ok') listed.push(item)
  }

  async function classify ({ person, base, personUserId }) {
    const read = await readMyPoffLinks(xapi, person.fiona_person_id)
    if (read.error) return { ...base, category: 'fiona-error', error: read.error }
    if (read.linkIds.length > 1) multipleLinks++

    const ownUser = personUserId ? await userOf(personUserId) : null
    if (!read.linkIds.length) {
      if (!personUserId) return { ...base, category: 'unlinked-no-user', fionaAnswer: read.answer }
      return { ...base, category: 'unlinked-repairable', userId: personUserId, repairUserId: groupOf(ownUser, personUserId), fionaAnswer: read.answer }
    }

    const linkedUserId = Number(read.linkIds[0])
    const linkedUser = await userOf(linkedUserId)
    const withIds = { ...base, ...(personUserId ? { userId: personUserId } : {}), linkedUserId }
    if (!linkedUser) return { ...withIds, category: 'linked-to-missing-user' }
    if (relationId(linkedUser.mainUser)) return { ...withIds, category: 'linked-to-alias' }
    if (!personUserId) return { ...withIds, category: 'linked-person-has-no-user' }
    return { ...withIds, category: groupOf(ownUser, personUserId) === Number(linkedUser.id) ? 'linked-ok' : 'linked-other-user' }
  }

  return { total, offset: requested.length ? 0 : start, limit: requested.length ? requested.length : pageSize, nextOffset, audited: people.length, counts, multipleLinks, persons: listed, skipped }
}
