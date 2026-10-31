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
 *  - names and the kept record's URLs stay; a missing slug is taken from the other record; but the survivor never keeps an
 *    indexed slug ("name-1") while the other record has the plain one ("name"): the two swap (see planSlugs)
 *  - Fiona ids come from the sync-managed record; the login user and the address move to the kept record
 *  - the record that is merged away is renamed "<name> (archived)" when it is hidden
 *  - a record that is used elsewhere (film credits, passes, articles, ...) is never the one removed, unless `repointCredits`
 *    is asked for: then its credits in films, courses, projects, teams, ... are pointed to the kept record first (see
 *    personCredits.js); a use that cannot be moved (a festival pass) still stops the pair
 *  - the login user is linked from the person side, never with PUT /users (its hook mails the person)
 *  - two different login users (`aliasLogins`): Fiona's login (the one MyPoff knows for the Fiona person) is the main one and
 *    stays on the person; the other becomes its alias (a login identity only: hunt then signs in as the main one). A login
 *    that owns purchases, payments, an organisation or roles the main one lacks is never made an alias, unless `moveToMain`
 *    says that its roles (added to the main login's), organisation and business profiles (moved to it) may move across.
 *  - every save is silent: `cgFormSave` stops the "Creative Gate profile created" e-mail and `skipbuild` the site build
 */

import { normalizeName } from './extraFields.js'
import { creditsPatch, creditCount, CREDIT_SOURCES } from './personCredits.js'

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
const SLUG_FIELDS = ['slug_et', 'slug_en', 'slug_ru']
const INDEXED_SLUG = /-\d+$/ // Strapi's unique slug when the plain one is taken: "juan-suarez-1"

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
const isIndexed = slug => INDEXED_SLUG.test(String(slug ?? ''))
const unindexed = slug => String(slug ?? '').replace(INDEXED_SLUG, '')
const unarchived = value => String(value ?? '').replace(/\s*\(archived\)\s*$/, '')
const label = refs => asList(refs).slice(0, 3).map(ref => `${ref.source} #${ref.id}`).join(', ')

const componentContent = component => Object.fromEntries(Object.entries(component || {}).filter(([key, value]) => !['id', '_id', '__component'].includes(key) && !isEmpty(value)))
const roleOf = row => (row?.role_at_film === null || row?.role_at_film === undefined ? null : Number(idOf(row.role_at_film)))

/**
 * The survivor should have the good slug. When the kept record has "name-1" and the other record the plain "name" (the
 * other record was there first, or the kept one is the newer), the two swap: the plain slug is freed on the other
 * record, taken by the kept one, and the other record (hidden, "(archived)") gets the indexed one, so it is never left
 * without a slug and never holds the good one. Per language; only for the same name (the plain slug is the indexed
 * one without its number).
 * @returns {null | { keep: object, free: object, retire: object }} keep = the kept record's new slugs, free = nulls on the
 *   other record (a uid is unique), retire = what the other record is left with
 */
export function planSlugs ({ keep, remove }) {
  const plan = { keep: {}, free: {}, retire: {} }
  for (const field of SLUG_FIELDS) {
    const kept = keep?.[field]
    const other = remove?.[field]
    if (isEmpty(kept) || isEmpty(other) || !isIndexed(kept) || isIndexed(other) || unindexed(kept) !== other) continue
    plan.keep[field] = other
    plan.free[field] = null
    plan.retire[field] = kept
  }
  return Object.keys(plan.keep).length ? plan : null
}

/**
 * @returns {{ ok: false, reason: string } | { ok: true, patch: object, preRemovePatch: object|null, retirePatch: object, link: object, changes: string[] }}
 *   patch = what the kept record gets; preRemovePatch = unique values freed on the record to remove first;
 *   retirePatch = what the record to remove is left with; link = login user and address to move
 */
export function planMerge ({ keep, remove, removeRefs = [], mainUserId = null, ignoreEventivalIds = false }) {
  if (Number(keep.id) === Number(remove.id)) return { ok: false, reason: 'same record' }
  for (const person of [keep, remove]) if (isArchived(person)) return { ok: false, reason: `#${person.id} is already archived` }
  if (nameOf(keep) !== nameOf(remove)) return { ok: false, reason: `names differ ("${keep.firstNameLastName}" and "${remove.firstNameLastName}")` }
  if (asList(removeRefs).length) return { ok: false, reason: `the record to remove (#${remove.id}) is used in ${label(removeRefs)}` }
  if (keep.fiona_person_id && remove.fiona_person_id && keep.fiona_person_id !== remove.fiona_person_id) return { ok: false, reason: 'both are sync-managed, with different Fiona ids' }
  const keepUser = idOf(keep.user)
  const removeUser = idOf(remove.user)
  const twoLogins = keepUser && removeUser && Number(keepUser) !== Number(removeUser)
  if (twoLogins && !mainUserId) return { ok: false, reason: `different login users (#${keepUser} and #${removeUser})` }
  for (const field of ignoreEventivalIds ? [] : ['remoteId', 'eventival_id']) { // Eventival ids are history: `ignoreEventivalIds` lets two different ones pass (the kept record's own id stays)
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
  const slugSwap = planSlugs({ keep, remove })
  if (slugSwap) {
    Object.assign(patch, slugSwap.keep)
    Object.assign(preRemovePatch, slugSwap.free)
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
    userId: Number(twoLogins ? mainUserId : (keepUser || removeUser)) || null,
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
  if (slugSwap) Object.assign(retirePatch, slugSwap.retire)

  return { ok: true, patch, preRemovePatch: Object.keys(preRemovePatch).length ? preRemovePatch : null, retirePatch, link, changes: Object.keys(patch) }
}

function sameInPerson (key, expected, actual) {
  if (key === 'orderedRaF') return expected.every(row => asList(actual).some(have => roleOf(have) === roleOf(row)))
  if (SINGLE_COMPONENTS.includes(key)) return !isEmpty(componentContent(actual))
  if (Array.isArray(expected)) return expected.every(id => idsOf(actual).includes(Number(id)))
  if (LATEST_RELATIONS.includes(key)) return Number(idOf(actual)) === Number(expected)
  return sameValue(expected, actual)
}

async function verifyMerge ({ strapi, plan, keepId, removeId, retire, alias = null, log }) {
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
  if (alias) {
    for (const aliasId of alias.aliases) {
      const aliasUser = await strapi.getUser(aliasId)
      if (Number(idOf(aliasUser?.mainUser)) !== alias.main) problems.push(`login #${aliasId} is not an alias of #${alias.main}`)
      if (Number(idOf(aliasUser?.person)) === Number(keepId)) problems.push(`login #${aliasId} is still on person #${keepId}`)
    }
    if (Object.keys(alias.moves).length) {
      const main = await strapi.getUser(alias.main)
      if (alias.moves.user_roles && !alias.moves.user_roles.every(id => idsOf(main?.user_roles).includes(id))) problems.push(`the roles are not all on login #${alias.main}`)
      if (alias.moves.organisation && Number(idOf(main?.organisation)) !== alias.moves.organisation) problems.push(`organisation #${alias.moves.organisation} is not on login #${alias.main}`)
      if (alias.moves.business_profiles && !alias.moves.business_profiles.every(id => idsOf(main?.business_profiles).includes(id))) problems.push(`the business profiles are not all on login #${alias.main}`)
    }
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
  } else {
    for (const field of SLUG_FIELDS) {
      if (field in plan.retirePatch && removed[field] !== plan.retirePatch[field]) problems.push(`${field} of #${removeId} is not ${plan.retirePatch[field]}`)
    }
  }
  return { ok: problems.length === 0, problems }
}

/**
 * What stops a login from becoming an alias (an alias is only a login identity, the main login owns everything else), and
 * what may move to the main login instead when `moveToMain` allows it: its roles (added to the main login's), its
 * organisation and its business profiles.
 */
function aliasBlockers (aliasUser, mainUser, moveToMain = []) {
  const blockers = []
  const moves = {}
  const movesLabel = {}
  const may = what => asList(moveToMain).includes(what)
  if (idOf(aliasUser.mainUser) && Number(idOf(aliasUser.mainUser)) !== Number(mainUser.id)) blockers.push(`it is an alias of #${idOf(aliasUser.mainUser)} already`)
  if (idOf(mainUser.mainUser)) blockers.push(`the main login #${mainUser.id} is an alias of #${idOf(mainUser.mainUser)} itself`)
  if (asList(aliasUser.aliasUsers).length) blockers.push('it has aliases of its own')
  if (asList(aliasUser.my_products).length) blockers.push(`it owns ${asList(aliasUser.my_products).length} product(s) (passes, tickets)`)
  if (asList(aliasUser.transactions).length) blockers.push(`it has ${asList(aliasUser.transactions).length} payment(s)`)
  if (!isEmpty(aliasUser.moodle_id)) blockers.push('it has a Moodle account')
  if (idOf(aliasUser.order)) blockers.push('it has an order')

  const aliasProfiles = idsOf(aliasUser.business_profiles)
  if (aliasProfiles.length) {
    if (may('businessProfiles')) {
      moves.business_profiles = [...new Set([...idsOf(mainUser.business_profiles), ...aliasProfiles])]
      movesLabel.businessProfiles = aliasProfiles
    } else blockers.push('it has a business profile')
  }
  const aliasOrganisation = Number(idOf(aliasUser.organisation)) || null
  if (aliasOrganisation) {
    const mainOrganisation = Number(idOf(mainUser.organisation)) || null
    if (!may('organisation')) blockers.push('it belongs to an organisation')
    else if (mainOrganisation && mainOrganisation !== aliasOrganisation) blockers.push(`both logins belong to an organisation (#${aliasOrganisation} and #${mainOrganisation}), and one cannot take the other`)
    else if (!mainOrganisation) {
      moves.organisation = aliasOrganisation
      movesLabel.organisation = aliasOrganisation
    }
  }
  const mainRoles = idsOf(mainUser.user_roles)
  const lacking = asList(aliasUser.user_roles).filter(role => !mainRoles.includes(Number(idOf(role))))
  if (lacking.length) {
    if (may('roles')) {
      moves.user_roles = [...mainRoles, ...lacking.map(role => Number(idOf(role)))]
      movesLabel.roles = lacking.map(role => role.name || `#${idOf(role)}`)
    } else blockers.push(`it has role(s) the main login lacks (${lacking.map(role => role.name || `#${idOf(role)}`).join(', ')})`)
  }
  return { blockers, moves, movesLabel }
}

/**
 * Which login is the main one, and whether the others may become its aliases. Normally of two different logins the one
 * Fiona knows is the main one; a pair may also NAME the main login (`mainUserId`): one of the two, or a third (Fiona's)
 * that belongs to no other person, and then both person logins become aliases.
 */
async function planAlias ({ strapi, keepUser, removeUser, keepId, removeId, fionaPersonId, fionaLogin, mainUserId = null, moveToMain = [] }) {
  const logins = `#${keepUser} and #${removeUser}`
  const candidates = [removeUser, keepUser] // the sync-made record's login first
  let main = Number(mainUserId) || null
  if (!main) {
    if (!fionaPersonId) return { ok: false, reason: `two logins (${logins}), and neither record is synced from Fiona, so nothing says which is the main one` }
    if (typeof fionaLogin !== 'function') return { ok: false, reason: `two logins (${logins}), and Fiona cannot be asked which is the main one` }
    let fiona = null
    try {
      fiona = Number(await fionaLogin(fionaPersonId)) || null
    } catch (err) {
      // Fiona not answering for one person (no published accreditation, ...) is a reason to leave this pair, not to stop the batch
      return { ok: false, reason: `two logins (${logins}), and Fiona's login cannot be read: ${err?.message || err}` }
    }
    if (!fiona) return { ok: false, reason: `two logins (${logins}), and Fiona knows no login for this person` }
    if (!candidates.includes(fiona)) return { ok: false, reason: `two logins (${logins}), and Fiona's login is #${fiona}, neither of them` }
    main = fiona
  }
  const mainUser = await strapi.getUser(main)
  if (!mainUser) return { ok: false, reason: `login #${main} cannot be read` }
  if (!candidates.includes(main)) {
    const holder = Number(idOf(mainUser.person)) || null
    if (holder && ![Number(keepId), Number(removeId)].includes(holder)) return { ok: false, reason: `login #${main} belongs to person #${holder}, which is not part of this merge` }
  }

  const aliasIds = candidates.filter(id => id !== main)
  const aliasUsers = []
  const notes = []
  const moves = {}
  const movesLabel = {}
  let virtual = mainUser // the main login as it will be after the moves so far
  for (const aliasId of aliasIds) {
    const aliasUser = await strapi.getUser(aliasId)
    if (!aliasUser) return { ok: false, reason: `login #${aliasId} cannot be read` }
    const found = aliasBlockers(aliasUser, virtual, moveToMain)
    if (found.blockers.length) return { ok: false, reason: `login #${aliasId} cannot become an alias of #${main}: ${found.blockers.join('; ')}` }
    if (found.moves.user_roles) { moves.user_roles = found.moves.user_roles; virtual = { ...virtual, user_roles: found.moves.user_roles.map(id => ({ id })) } }
    if (found.moves.organisation) { moves.organisation = found.moves.organisation; virtual = { ...virtual, organisation: { id: found.moves.organisation } } }
    if (found.moves.business_profiles) { moves.business_profiles = found.moves.business_profiles; virtual = { ...virtual, business_profiles: found.moves.business_profiles.map(id => ({ id })) } }
    for (const [key, value] of Object.entries(found.movesLabel)) movesLabel[key] = Array.isArray(value) ? [...(movesLabel[key] || []), ...value] : value
    if (idOf(aliasUser.cart)) notes.push(`the alias login #${aliasId} has a cart`)
    aliasUsers.push(aliasUser)
  }
  // someone linked the logins before: only the persons are left to merge
  const alreadyAlias = aliasUsers.every(user => Number(idOf(user.mainUser)) === main)
  return { ok: true, plan: { main, alias: aliasIds[0], aliases: aliasIds, mainUser, aliasUser: aliasUsers[0], aliasUsers, mainAliases: idsOf(mainUser.aliasUsers), moves, movesLabel, notes, alreadyAlias } }
}

/** What to write in each entry that credits the record to remove; ok: false (with the reason) when one cannot be moved. */
async function planCredits ({ strapi, keepId, removeId, refs }) {
  const plans = []
  for (const ref of refs) {
    const entry = await strapi.getCreditEntry(ref.source, ref.id)
    if (!entry) return { ok: false, reason: `${ref.source} #${ref.id} (which names #${removeId}) cannot be read` }
    const result = creditsPatch({ source: ref.source, entry, fromId: removeId, toId: keepId })
    if (!result.ok) return { ok: false, reason: `${ref.source} #${ref.id}: ${result.reason}` }
    if (!result.found) return { ok: false, reason: `#${removeId} is used in ${ref.source} #${ref.id}, but not where credits are looked for` }
    plans.push({ source: ref.source, id: ref.id, entry, patch: result.patch, changes: result.changes, dropped: result.dropped })
  }
  return { ok: true, plans }
}

/** Read every written entry again: no credit names the old record any more and none was lost (or doubled). */
async function verifyCredits ({ strapi, plans, keepId, removeId }) {
  const problems = []
  for (const { source, id, entry, dropped } of plans) {
    const after = await strapi.getCreditEntry(source, id)
    if (!after) { problems.push(`${source} #${id} cannot be read after the write`); continue }
    if (creditCount(source, after, removeId) > 0) problems.push(`${source} #${id} still names #${removeId}`)
    const expected = creditCount(source, entry, keepId) + creditCount(source, entry, removeId) - dropped
    if (creditCount(source, after, keepId) !== expected) problems.push(`${source} #${id} names #${keepId} ${creditCount(source, after, keepId)} times, expected ${expected}`)
  }
  return problems
}

/**
 * Merge `removeId` into `keepId`.
 * @param {{ keepId: number, removeId: number, strapi: object, dryRun?: boolean, retire?: 'hide'|'delete', removeRefs?: object[], repointCredits?: boolean, aliasLogins?: boolean, moveToMain?: string[], mainUserId?: number, ignoreEventivalIds?: boolean, fionaLogin?: (fionaPersonId: string) => Promise<number|string|null>, log?: object }} options
 * @returns {Promise<object>} status: dry-run | merged | skipped | check-failed | failed
 */
export async function mergePersons ({ keepId, removeId, strapi, dryRun = true, retire = 'hide', removeRefs = [], repointCredits = false, aliasLogins = false, moveToMain = [], mainUserId = null, ignoreEventivalIds = false, fionaLogin = null, log = console }) {
  const result = { keep: Number(keepId), remove: Number(removeId), name: null, status: 'skipped' }
  try {
    const keep = await strapi.findPersonById(keepId)
    const remove = await strapi.findPersonById(removeId)
    if (!keep || !remove) return { ...result, reason: `#${keep ? removeId : keepId} does not exist` }
    result.name = keep.firstNameLastName || [keep.firstName, keep.lastName].filter(Boolean).join(' ')

    const keepUser = Number(idOf(keep.user)) || null
    const removeUser = Number(idOf(remove.user)) || null
    let alias = { ok: true, plan: null }
    if (aliasLogins && keepUser && removeUser && keepUser !== removeUser) {
      alias = await planAlias({ strapi, keepUser, removeUser, keepId: Number(keepId), removeId: Number(removeId), fionaPersonId: remove.fiona_person_id || keep.fiona_person_id, fionaLogin, mainUserId, moveToMain })
      if (!alias.ok) return { ...result, reason: alias.reason }
    }
    const movable = repointCredits ? asList(removeRefs).filter(ref => CREDIT_SOURCES.includes(ref.source)) : []
    const plan = planMerge({ keep, remove, removeRefs: repointCredits ? asList(removeRefs).filter(ref => !CREDIT_SOURCES.includes(ref.source)) : removeRefs, mainUserId: alias.plan?.main ?? null, ignoreEventivalIds })
    if (!plan.ok) return { ...result, reason: plan.reason }
    const credits = movable.length ? await planCredits({ strapi, keepId: Number(keepId), removeId: Number(removeId), refs: movable }) : { ok: true, plans: [] }
    if (!credits.ok) return { ...result, reason: credits.reason }
    Object.assign(result, { changes: plan.changes, link: plan.link, retire })
    if (credits.plans.length) result.credits = credits.plans.map(({ source, id, changes, dropped }) => ({ source, id, changes, dropped }))
    if (alias.plan) result.alias = { main: alias.plan.main, alias: alias.plan.alias, ...(alias.plan.aliases.length > 1 ? { aliases: alias.plan.aliases } : {}), notes: alias.plan.notes, ...(alias.plan.alreadyAlias ? { alreadyAlias: true } : {}), ...(Object.keys(alias.plan.movesLabel).length ? { moves: alias.plan.movesLabel } : {}) }
    if (dryRun) return { ...result, status: 'dry-run' }

    result.backup = { keep: copyOf(keep), remove: copyOf(remove) }
    if (alias.plan) result.backup.users = { main: copyOf(alias.plan.mainUser), alias: copyOf(alias.plan.aliasUser), ...(alias.plan.aliases.length > 1 ? { aliases: alias.plan.aliasUsers.map(copyOf) } : {}) }
    if (credits.plans.length) {
      result.backup.credits = credits.plans.map(({ source, id, patch, entry }) => ({ source, id, before: copyOf(Object.fromEntries(Object.keys(patch).map(key => [key, entry[key]]))) }))
      // first: if the persons cannot be merged after this, the credits are on the record that stays
      for (const credit of credits.plans) await strapi.updateCreditEntry(credit.source, credit.id, { ...credit.patch, skipbuild: true })
      const problems = await verifyCredits({ strapi, plans: credits.plans, keepId: Number(keepId), removeId: Number(removeId) })
      if (problems.length) return { ...result, status: 'check-failed', verify: { ok: false, problems } }
    }
    if (plan.preRemovePatch) await strapi.updatePerson(removeId, { ...plan.preRemovePatch, ...SILENT })
    if (plan.changes.length) await strapi.updatePerson(keepId, { ...plan.patch, ...SILENT })
    if (plan.link.addressMove) await strapi.moveAddressToPerson(plan.link.addressMove, keepId)
    if (plan.link.addressCountry) await strapi.setAddressCountry(plan.link.addressCountry.addressId, plan.link.addressCountry.countryId)
    if (retire === 'delete') await strapi.deletePerson(removeId)
    else await strapi.updatePerson(removeId, { ...plan.retirePatch, ...SILENT })
    // The login user is linked LAST and from the person side: taking it off the other record clears it on the user, and
    // PUT /users/:id would run the user model's hook, which sends the Creative Gate "profile created" mail (twice here).
    if (plan.link.userId) await strapi.updatePerson(keepId, { user: plan.link.userId, ...SILENT })

    // the other login becomes an alias of the main one (a plain user update, after the person has the main login)
    if (alias.plan) {
      // what the alias login owned goes to the main login first (one plain user update from the user side)
      if (Object.keys(alias.plan.moves).length) await strapi.setUserFields(alias.plan.main, alias.plan.moves)
      if (!alias.plan.alreadyAlias) await strapi.setAliasUsers(alias.plan.main, [...new Set([...alias.plan.mainAliases, ...alias.plan.aliases])])
      // linking the main login to the person may leave an alias login on it too: an alias is a login identity only
      for (const aliasId of alias.plan.aliases) {
        if (Number(idOf((await strapi.getUser(aliasId))?.person)) === Number(keepId)) await strapi.clearUserPerson(aliasId)
      }
    }

    result.verify = await verifyMerge({ strapi, plan, keepId, removeId, retire, alias: alias.plan, log })
    result.status = result.verify.ok ? 'merged' : 'check-failed'
    return result
  } catch (err) {
    log.error?.(`[merge] #${removeId} into #${keepId}: ${err?.message || err}`)
    return { ...result, status: 'failed', error: err?.message || String(err) }
  }
}

/** The pairs of a batch: numbers only, no repeats; refuses a batch that is too long. */
function pairList (pairs, what) {
  const list = []
  const seen = new Set()
  for (const pair of Array.isArray(pairs) ? pairs : []) {
    const key = `${Number(pair?.keep)}>${Number(pair?.remove)}`
    if (!Number.isFinite(Number(pair?.keep)) || !Number.isFinite(Number(pair?.remove)) || seen.has(key)) continue
    seen.add(key)
    list.push({ keep: Number(pair.keep), remove: Number(pair.remove), mainUser: Number(pair.mainUser) || null })
  }
  if (list.length > MAX_PAIRS) throw new Error(`${what} takes at most ${MAX_PAIRS} pairs per call`)
  return list
}

/**
 * Merge several pairs one after the other; stops at the first pair that fails or does not check out.
 * The places that use the persons to remove are read once for the whole batch (a slow read), and the batch refuses to
 * run when one of those places cannot be read: "not used" would then be a guess.
 */
export async function mergeBatch ({ pairs, strapi, dryRun = true, retire = 'hide', repointCredits = false, aliasLogins = false, moveToMain = [], ignoreEventivalIds = false, fionaLogin = null, log = console }) {
  const list = pairList(pairs, 'merge')
  if (!['hide', 'delete'].includes(retire)) throw new Error('retire must be "hide" or "delete"')

  const references = list.length ? await strapi.findPersonReferences(list.map(pair => pair.remove)) : { refs: {}, failed: [] }
  if (asList(references.failed).length) {
    throw new Error(`the places that use persons could not all be read (${references.failed.map(f => `${f.source}: ${f.error}`).join('; ')}), so nothing was merged`)
  }

  const results = []
  let stoppedAt = null
  for (const pair of list) {
    const result = await mergePersons({ keepId: pair.keep, removeId: pair.remove, strapi, dryRun, retire, removeRefs: references.refs?.[pair.remove] || [], repointCredits, aliasLogins, moveToMain, mainUserId: pair.mainUser, ignoreEventivalIds, fionaLogin, log })
    results.push(result)
    if (result.status === 'failed' || result.status === 'check-failed') { stoppedAt = { keep: pair.keep, remove: pair.remove }; break }
  }
  const counts = { merged: 0, skipped: 0, 'dry-run': 0, 'check-failed': 0, failed: 0 }
  for (const result of results) counts[result.status]++
  log.info?.(`[merge] ${dryRun ? 'dry run' : 'run'}: ${JSON.stringify(counts)}${stoppedAt ? ` — stopped at #${stoppedAt.remove} into #${stoppedAt.keep}` : ''}`)
  return { mode: 'merge', dryRun, retire, repointCredits, aliasLogins, moveToMain: asList(moveToMain), ignoreEventivalIds, pairs: list.length, counts, stoppedAt, results }
}

/**
 * Give the survivor of a pair that was merged earlier the good slug (see planSlugs). Also the survivor that took the indexed
 * slug of a copy that had none: it gets the plain slug when nobody holds it; a pair whose plain slug a third record holds is
 * left alone and says who. Writes are silent; the slugs are read back.
 * @returns {Promise<object>} status: dry-run | repaired | unchanged | skipped | check-failed | failed
 */
async function repairSlugs ({ keepId, removeId, strapi, dryRun, log }) {
  const result = { keep: Number(keepId), remove: Number(removeId), name: null, status: 'skipped' }
  let freed = null
  try {
    const keep = await strapi.findPersonById(keepId)
    const remove = await strapi.findPersonById(removeId)
    if (!keep || !remove) return { ...result, reason: `#${keep ? removeId : keepId} does not exist` }
    result.name = unarchived(keep.firstNameLastName || [keep.firstName, keep.lastName].filter(Boolean).join(' '))
    if (isArchived(keep)) return { ...result, reason: `the survivor #${keepId} is archived` }
    if (!isArchived(remove)) return { ...result, reason: `#${removeId} is not archived (this only repairs pairs that were merged)` }
    if (normalizeName(unarchived(keep.firstNameLastName)) !== normalizeName(unarchived(remove.firstNameLastName))) return { ...result, reason: `names differ ("${keep.firstNameLastName}" and "${remove.firstNameLastName}")` }

    const swap = planSlugs({ keep, remove })
    const keepPatch = { ...(swap?.keep || {}) }
    const changes = Object.entries(keepPatch).map(([field, slug]) => `${field}: ${keep[field]} → ${slug} (the archived copy gets ${keep[field]})`)
    const blocked = []
    for (const field of SLUG_FIELDS) { // a copy that had no slug: the survivor took its indexed one
      if (field in keepPatch || isEmpty(keep[field]) || !isIndexed(keep[field]) || !isEmpty(remove[field])) continue
      const plain = unindexed(keep[field])
      const holders = asList(await strapi.findPeopleBySlug(field, plain)).filter(holder => Number(holder.id) !== Number(keepId))
      if (holders.length) blocked.push(`${field} ${plain} is held by #${holders[0].id} (${holders[0].firstNameLastName})`)
      else {
        keepPatch[field] = plain
        changes.push(`${field}: ${keep[field]} → ${plain}`)
      }
    }
    if (blocked.length) return { ...result, reason: blocked.join('; ') }
    if (!Object.keys(keepPatch).length) return { ...result, status: 'unchanged', reason: 'the survivor has the good slugs already' }
    result.changes = changes
    if (dryRun) return { ...result, status: 'dry-run' }

    const pick = person => Object.fromEntries(SLUG_FIELDS.map(field => [field, person[field] ?? null]))
    result.backup = { keep: pick(keep), remove: pick(remove) }
    if (swap) {
      freed = Object.keys(swap.free)
      await strapi.updatePerson(removeId, { ...swap.free, ...SILENT })
    }
    await strapi.updatePerson(keepId, { ...keepPatch, ...SILENT })
    if (swap) await strapi.updatePerson(removeId, { ...swap.retire, ...SILENT })
    freed = null

    const problems = []
    const after = await strapi.findPersonById(keepId)
    const archivedAfter = await strapi.findPersonById(removeId)
    for (const [field, slug] of Object.entries(keepPatch)) if (after?.[field] !== slug) problems.push(`${field} of #${keepId} is not ${slug}`)
    for (const [field, slug] of Object.entries(swap?.retire || {})) if (archivedAfter?.[field] !== slug) problems.push(`${field} of #${removeId} is not ${slug}`)
    result.verify = { ok: problems.length === 0, problems }
    result.status = result.verify.ok ? 'repaired' : 'check-failed'
    return result
  } catch (err) {
    log.error?.(`[slugs] #${removeId} into #${keepId}: ${err?.message || err}`)
    const failed = { ...result, status: 'failed', error: err?.message || String(err) }
    if (freed && result.backup) { // the plain slug was freed on the archived copy but the survivor did not get it: give it back
      try {
        await strapi.updatePerson(removeId, { ...Object.fromEntries(freed.map(field => [field, result.backup.remove[field]])), ...SILENT })
        failed.restored = true
      } catch (restoreError) {
        failed.restored = false
        log.error?.(`[slugs] #${removeId}: the slugs could not be given back: ${restoreError?.message || restoreError}`)
      }
    }
    return failed
  }
}

/** Repair the slugs of pairs that were merged earlier, one after the other; stops at the first pair that fails or does not check out. A dry run unless told otherwise. */
export async function repairSlugsBatch ({ pairs, strapi, dryRun = true, log = console }) {
  const list = pairList(pairs, 'slugs')
  const results = []
  let stoppedAt = null
  for (const pair of list) {
    const result = await repairSlugs({ keepId: pair.keep, removeId: pair.remove, strapi, dryRun, log })
    results.push(result)
    if (result.status === 'failed' || result.status === 'check-failed') { stoppedAt = { keep: pair.keep, remove: pair.remove }; break }
  }
  const counts = { repaired: 0, unchanged: 0, skipped: 0, 'dry-run': 0, 'check-failed': 0, failed: 0 }
  for (const result of results) counts[result.status]++
  log.info?.(`[slugs] ${dryRun ? 'dry run' : 'run'}: ${JSON.stringify(counts)}${stoppedAt ? ` — stopped at #${stoppedAt.remove} into #${stoppedAt.keep}` : ''}`)
  return { mode: 'slugs', dryRun, pairs: list.length, counts, stoppedAt, results }
}
