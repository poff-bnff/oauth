/**
 * fiona/personMerge.js
 *
 * Merge two Strapi person records that are one human into one: everything of the record to remove is moved onto the
 * record to keep, then the record to remove is hidden (or deleted). Generic: no Fiona logic beyond carrying the Fiona
 * ids over, so an admin merge feature can call it later.
 *
 * Rules (decided with Jaan):
 *  - single values (e-mail, phone, bio, picture, ...): the most recently updated record's value wins, the other fills gaps
 *  - lists and relations (organisations, editions, roles, categories, images, ...): both added together, nothing taken away
 *  - names and the kept record's URLs stay; a missing slug is taken from the other record
 *  - Fiona ids come from the sync-managed record; the login user and the address move to the kept record
 *  - the record that is merged away is renamed "<name> (archived)" when it is hidden
 *  - a record that is used elsewhere (film credits, passes, articles, ...) is never the one removed
 *  - the login user is linked from the person side, never with PUT /users (its hook mails the person)
 *  - every save is silent: `cgFormSave` stops the "Creative Gate profile created" e-mail and `skipbuild` the site build
 */

import { normalizeName } from './extraFields.js'

const MAX_PAIRS = 100
const SILENT = { cgFormSave: true, skipbuild: true }

// "latest non-empty wins"
const LATEST_VALUES = [
  'phoneNr', 'eMail', 'dateOfBirth', 'profession', 'pageUrl', 'height_cm', 'weight_kg', 'ev_account_email', 'ev_contact_email',
  'ev_org_name', 'ev_job_title', 'bio_et', 'bio_en', 'bio_ru', 'ev_professions', 'ev_fow', 'ev_img_url', 'showreel',
  'acting_age_from', 'acting_age_to', 'acc_imdb', 'acc_efis', 'acc_castupload', 'acc_instagram', 'acc_fb', 'acc_other',
  'webpage_url', 'repr_p_name', 'repr_phone', 'repr_email', 'repr_org_name', 'repr_org_url', 'acc_etalenta', 'skills_et',
  'skills_en', 'skills_ru', 'looking_for', 'h_rate_from', 'h_rate_to', 'acc_youtube', 'acc_vimeo'
]
const FILL_VALUES = ['images_updated_at', 'images_log'] // the kept record's value stays; an empty one is filled
const LATEST_RELATIONS = ['gender', 'eye_colour', 'hair_colour', 'shoe_size', 'stature', 'pitch_of_voice', 'ev_country', 'hair_length', 'native_lang', 'origin', 'picture', 'profile_img']
const UNION_RELATIONS = ['organisations', 'festival_editions', 'domains', 'role_at_films', 'other_lang', 'tag_secrets', 'industry_person_types', 'tag_looking_fors', 'industry_categories', 'images', 'audioreel']
const OR_FLAGS = ['public', 'show_in_cg_search']
const UNIQUE_VALUES = ['slug_et', 'slug_en', 'slug_ru', 'remoteId', 'eventival_id'] // unique in Strapi: freed on the other record before the kept one takes it
const FIONA_FIELDS = ['fiona_person_id', 'fiona_accreditation_id', 'fiona_guestbook_ids', 'fiona_attached_edition_ids', 'fiona_assigned_role_ids', 'fiona_synced_at', 'fiona_unpublished_at']
const SINGLE_COMPONENTS = ['biography', 'filmography']
const ARCHIVED = ' (archived)' // added to the name of the record that is merged away

const asList = value => (Array.isArray(value) ? value : [])
const idOf = value => (value && typeof value === 'object' ? value.id : value)
const idsOf = value => asList(value).map(item => Number(idOf(item))).filter(Number.isFinite)
const sameValue = (a, b) => String(a ?? '') === String(b ?? '')
const isEmpty = value => value === null || value === undefined || value === '' ||
  (Array.isArray(value) && !value.length) || (typeof value === 'object' && !Array.isArray(value) && !Object.keys(value).length)
const nameOf = person => normalizeName(person?.firstNameLastName || [person?.firstName, person?.lastName].filter(Boolean).join(' '))
const timeOf = person => Date.parse(person?.updated_at) || 0
const isArchived = person => String(person?.firstNameLastName ?? '').trimEnd().endsWith(ARCHIVED.trim()) || String(person?.lastName ?? '').trimEnd().endsWith(ARCHIVED.trim())
const copyOf = value => JSON.parse(JSON.stringify(value)) // not structuredClone: the app's Node has none
const label = refs => asList(refs).slice(0, 3).map(ref => `${ref.source} #${ref.id}`).join(', ')

const componentContent = component => Object.fromEntries(Object.entries(component || {}).filter(([key, value]) => !['id', '_id', '__component'].includes(key) && !isEmpty(value)))
const roleOf = row => (row?.role_at_film === null || row?.role_at_film === undefined ? null : Number(idOf(row.role_at_film)))

/**
 * @returns {{ ok: false, reason: string } | { ok: true, patch: object, preRemovePatch: object|null, retirePatch: object, link: object, changes: string[] }}
 *   patch = what the kept record gets; preRemovePatch = unique values freed on the record to remove first;
 *   retirePatch = what the record to remove is left with; link = login user and address to move
 */
export function planMerge ({ keep, remove, removeRefs = [] }) {
  if (Number(keep.id) === Number(remove.id)) return { ok: false, reason: 'same record' }
  for (const person of [keep, remove]) if (isArchived(person)) return { ok: false, reason: `#${person.id} is already archived` }
  if (nameOf(keep) !== nameOf(remove)) return { ok: false, reason: `names differ ("${keep.firstNameLastName}" and "${remove.firstNameLastName}")` }
  if (asList(removeRefs).length) return { ok: false, reason: `the record to remove (#${remove.id}) is used in ${label(removeRefs)}` }
  if (keep.fiona_person_id && remove.fiona_person_id && keep.fiona_person_id !== remove.fiona_person_id) return { ok: false, reason: 'both are sync-managed, with different Fiona ids' }
  const keepUser = idOf(keep.user)
  const removeUser = idOf(remove.user)
  if (keepUser && removeUser && Number(keepUser) !== Number(removeUser)) return { ok: false, reason: `different login users (#${keepUser} and #${removeUser})` }
  for (const field of ['remoteId', 'eventival_id']) {
    if (!isEmpty(keep[field]) && !isEmpty(remove[field]) && !sameValue(keep[field], remove[field])) return { ok: false, reason: `different ${field} (${keep[field]} and ${remove[field]})` }
  }

  const removeIsNewer = timeOf(remove) >= timeOf(keep)
  const patch = {}
  const preRemovePatch = {}

  const latest = (a, b) => (isEmpty(a) ? b : (isEmpty(b) ? a : (removeIsNewer ? b : a)))

  for (const field of LATEST_VALUES) {
    const value = latest(keep[field], remove[field])
    if (!isEmpty(value) && !sameValue(value, keep[field])) patch[field] = value
  }
  for (const field of FILL_VALUES) {
    if (isEmpty(keep[field]) && !isEmpty(remove[field])) patch[field] = remove[field]
  }
  for (const field of LATEST_RELATIONS) {
    const value = latest(idOf(keep[field]), idOf(remove[field]))
    if (!isEmpty(value) && Number(value) !== Number(idOf(keep[field]))) patch[field] = Number(value)
  }
  for (const field of UNION_RELATIONS) {
    const have = idsOf(keep[field])
    const added = idsOf(remove[field]).filter(id => !have.includes(id))
    if (added.length) patch[field] = [...new Set([...have, ...added])]
  }
  for (const field of OR_FLAGS) {
    if (remove[field] === true && keep[field] !== true) patch[field] = true
  }
  for (const field of UNIQUE_VALUES) {
    if (isEmpty(keep[field]) && !isEmpty(remove[field])) {
      patch[field] = remove[field]
      preRemovePatch[field] = null
    }
  }
  if (remove.fiona_person_id && !keep.fiona_person_id) {
    for (const field of FIONA_FIELDS) if (!sameValue(remove[field], keep[field])) patch[field] = remove[field]
  }
  for (const field of SINGLE_COMPONENTS) {
    const content = componentContent(remove[field])
    if (isEmpty(componentContent(keep[field])) && !isEmpty(content)) patch[field] = content
  }

  // the ordered roles: the kept record's rows stay (with their ids), the roles it lacks are added at the end
  const keepRows = asList(keep.orderedRaF)
  const haveRoles = new Set(keepRows.map(roleOf).filter(id => id !== null))
  const newRoles = []
  for (const row of [...asList(remove.orderedRaF)].sort((a, b) => (Number(a.order) || 0) - (Number(b.order) || 0))) {
    const role = roleOf(row)
    if (role === null || haveRoles.has(role)) continue
    haveRoles.add(role)
    newRoles.push(role)
  }
  if (newRoles.length) {
    let order = keepRows.reduce((max, row) => Math.max(max, Number(row.order) || 0), 0)
    patch.orderedRaF = [
      ...keepRows.map(row => ({ ...(row.id !== undefined ? { id: row.id } : {}), order: row.order, role_at_film: roleOf(row) })),
      ...newRoles.map(role => ({ order: ++order, role_at_film: role }))
    ]
  }

  const keepAddress = keep.addr_coll
  const removeAddress = remove.addr_coll
  const countryOf = address => (address && typeof address === 'object' && address.country ? Number(idOf(address.country)) : null)
  const link = {
    userId: Number(keepUser || removeUser) || null,
    addressMove: removeAddress && !keepAddress ? Number(idOf(removeAddress)) : null,
    addressCountry: keepAddress && removeAddress && typeof keepAddress === 'object' && !countryOf(keepAddress) && countryOf(removeAddress)
      ? { addressId: Number(idOf(keepAddress)), countryId: countryOf(removeAddress) }
      : null
  }

  const retirePatch = {
    ...Object.fromEntries(FIONA_FIELDS.map(field => [field, null])),
    eMail: null,
    public: false,
    show_in_cg_search: false,
    user: null
  }
  // the name tells the record apart in the admin and keeps it out of every later search for the name
  const fullName = String(remove.firstNameLastName || [remove.firstName, remove.lastName].filter(Boolean).join(' ')).trim()
  if (fullName) retirePatch.firstNameLastName = fullName + ARCHIVED
  if (String(remove.lastName ?? '').trim()) retirePatch.lastName = String(remove.lastName).trim() + ARCHIVED

  return { ok: true, patch, preRemovePatch: Object.keys(preRemovePatch).length ? preRemovePatch : null, retirePatch, link, changes: Object.keys(patch) }
}

function sameInPerson (key, expected, actual) {
  if (key === 'orderedRaF') return expected.every(row => asList(actual).some(have => roleOf(have) === roleOf(row)))
  if (SINGLE_COMPONENTS.includes(key)) return !isEmpty(componentContent(actual))
  if (Array.isArray(expected)) return expected.every(id => idsOf(actual).includes(Number(id)))
  if (LATEST_RELATIONS.includes(key)) return Number(idOf(actual)) === Number(expected)
  return sameValue(expected, actual)
}

async function verifyMerge ({ strapi, plan, keepId, removeId, retire, log }) {
  const problems = []
  const after = await strapi.findPersonById(keepId)
  if (!after) return { ok: false, problems: [`the kept record #${keepId} cannot be read`] }
  for (const [key, expected] of Object.entries(plan.patch)) {
    if (!sameInPerson(key, expected, after[key])) problems.push(`${key} was not written to #${keepId}`)
  }
  if (plan.link.addressMove && Number(idOf(after.addr_coll)) !== plan.link.addressMove) problems.push(`the address #${plan.link.addressMove} is not on #${keepId}`)
  if (plan.link.userId) {
    let user = await strapi.getUser(plan.link.userId)
    if (Number(idOf(user?.person)) !== Number(keepId)) {
      log.warn?.(`[merge] login user #${plan.link.userId} is not on #${keepId}: linking it again from the person side`)
      await strapi.updatePerson(keepId, { user: plan.link.userId, ...SILENT })
      user = await strapi.getUser(plan.link.userId)
    }
    if (Number(idOf(user?.person)) !== Number(keepId)) problems.push(`login user #${plan.link.userId} is not linked to #${keepId}`)
  }
  const removed = await strapi.findPersonById(removeId)
  if (retire === 'delete') {
    if (removed) problems.push(`#${removeId} still exists after the delete`)
  } else if (!removed) {
    problems.push(`#${removeId} cannot be read after hiding it`)
  } else if (removed.fiona_person_id || removed.eMail || removed.public !== false) {
    problems.push(`#${removeId} still carries its Fiona id, e-mail or is public`)
  } else if (!isArchived(removed)) {
    problems.push(`#${removeId} was not marked as archived`)
  }
  return { ok: problems.length === 0, problems }
}

/**
 * Merge `removeId` into `keepId`.
 * @param {{ keepId: number, removeId: number, strapi: object, dryRun?: boolean, retire?: 'hide'|'delete', removeRefs?: object[], log?: object }} options
 * @returns {Promise<object>} status: dry-run | merged | skipped | check-failed | failed
 */
export async function mergePersons ({ keepId, removeId, strapi, dryRun = true, retire = 'hide', removeRefs = [], log = console }) {
  const result = { keep: Number(keepId), remove: Number(removeId), name: null, status: 'skipped' }
  try {
    const keep = await strapi.findPersonById(keepId)
    const remove = await strapi.findPersonById(removeId)
    if (!keep || !remove) return { ...result, reason: `#${keep ? removeId : keepId} does not exist` }
    result.name = keep.firstNameLastName || [keep.firstName, keep.lastName].filter(Boolean).join(' ')

    const plan = planMerge({ keep, remove, removeRefs })
    if (!plan.ok) return { ...result, reason: plan.reason }
    Object.assign(result, { changes: plan.changes, link: plan.link, retire })
    if (dryRun) return { ...result, status: 'dry-run' }

    result.backup = { keep: copyOf(keep), remove: copyOf(remove) }
    if (plan.preRemovePatch) await strapi.updatePerson(removeId, { ...plan.preRemovePatch, ...SILENT })
    if (plan.changes.length) await strapi.updatePerson(keepId, { ...plan.patch, ...SILENT })
    if (plan.link.addressMove) await strapi.moveAddressToPerson(plan.link.addressMove, keepId)
    if (plan.link.addressCountry) await strapi.setAddressCountry(plan.link.addressCountry.addressId, plan.link.addressCountry.countryId)
    if (retire === 'delete') await strapi.deletePerson(removeId)
    else await strapi.updatePerson(removeId, { ...plan.retirePatch, ...SILENT })
    // The login user is linked LAST and from the person side: taking it off the other record clears it on the user, and
    // PUT /users/:id would run the user model's hook, which sends the Creative Gate "profile created" mail (twice here).
    if (plan.link.userId) await strapi.updatePerson(keepId, { user: plan.link.userId, ...SILENT })

    result.verify = await verifyMerge({ strapi, plan, keepId, removeId, retire, log })
    result.status = result.verify.ok ? 'merged' : 'check-failed'
    return result
  } catch (err) {
    log.error?.(`[merge] #${removeId} into #${keepId}: ${err?.message || err}`)
    return { ...result, status: 'failed', error: err?.message || String(err) }
  }
}

/**
 * Merge several pairs one after the other; stops at the first pair that fails or does not check out.
 * The places that use the persons to remove are read once for the whole batch (a slow read), and the batch refuses to
 * run when one of those places cannot be read: "not used" would then be a guess.
 */
export async function mergeBatch ({ pairs, strapi, dryRun = true, retire = 'hide', log = console }) {
  const list = []
  const seen = new Set()
  for (const pair of Array.isArray(pairs) ? pairs : []) {
    const key = `${Number(pair?.keep)}>${Number(pair?.remove)}`
    if (!Number.isFinite(Number(pair?.keep)) || !Number.isFinite(Number(pair?.remove)) || seen.has(key)) continue
    seen.add(key)
    list.push({ keep: Number(pair.keep), remove: Number(pair.remove) })
  }
  if (list.length > MAX_PAIRS) throw new Error(`merge takes at most ${MAX_PAIRS} pairs per call`)
  if (!['hide', 'delete'].includes(retire)) throw new Error('retire must be "hide" or "delete"')

  const references = list.length ? await strapi.findPersonReferences(list.map(pair => pair.remove)) : { refs: {}, failed: [] }
  if (asList(references.failed).length) {
    throw new Error(`the places that use persons could not all be read (${references.failed.map(f => `${f.source}: ${f.error}`).join('; ')}), so nothing was merged`)
  }

  const results = []
  let stoppedAt = null
  for (const pair of list) {
    const result = await mergePersons({ keepId: pair.keep, removeId: pair.remove, strapi, dryRun, retire, removeRefs: references.refs?.[pair.remove] || [], log })
    results.push(result)
    if (result.status === 'failed' || result.status === 'check-failed') { stoppedAt = pair; break }
  }
  const counts = { merged: 0, skipped: 0, 'dry-run': 0, 'check-failed': 0, failed: 0 }
  for (const result of results) counts[result.status]++
  log.info?.(`[merge] ${dryRun ? 'dry run' : 'run'}: ${JSON.stringify(counts)}${stoppedAt ? ` — stopped at #${stoppedAt.remove} into #${stoppedAt.keep}` : ''}`)
  return { mode: 'merge', dryRun, retire, pairs: list.length, counts, stoppedAt, results }
}
