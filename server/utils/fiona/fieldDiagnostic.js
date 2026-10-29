/**
 * fiona/fieldDiagnostic.js
 *
 * Read-only diagnostic: where does Fiona keep a value? For a few persons the sync manages it reads the raw record of
 * the person and of each of its accreditations from the Publication API and the XAPI and lists every field path with
 * its type. Values are shown only for the fields we look for (country, company, category / programme, occupation,
 * trip info such as arrival and departure, ...) and for lookup keys; everything else (names, contact details,
 * addresses) is reported as "exists, this type" only.
 * With `paths` it also reads further endpoints that are named explicitly (when a value sits in a sub-resource).
 */

const MAX_PERSONS = 5
const MAX_PATHS = 10
const MAX_EXAMPLES = 5
const MAX_VALUE_LENGTH = 80

// field names whose values are what we are looking for; their values are not personal contact data
const LOOKED_FOR = /countr|compan|organi[sz]|employer|categor|programme|occupation|profession|position|job|arriv|depart|trip|travel|flight|transport/i

const splitIds = value => String(value ?? '').split(',').map(id => id.trim()).filter(Boolean)

const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const isKeyValueList = list => list.length > 0 && list.every(item => isRecord(item) && typeof item.key === 'string' && 'value' in item)

function shorten (value) {
  const text = String(value)
  return text.length > MAX_VALUE_LENGTH ? `${text.slice(0, MAX_VALUE_LENGTH)}…` : text
}

/**
 * Every path of a JSON document with its type (arrays as `path[]` with a count, custom field lists as `path[key]`).
 * @returns {{ path: string, type: string, count?: number, values?: string[] }[]} sorted by path
 */
export function outlineFields (root) {
  const entries = new Map()

  function note (path, type, { count, example } = {}) {
    let entry = entries.get(path)
    if (!entry) {
      entry = { path, type, values: new Set() }
      entries.set(path, entry)
    }
    if (count !== undefined) entry.count = Math.max(entry.count ?? 0, count)
    if (example !== undefined && entry.values.size < MAX_EXAMPLES) entry.values.add(shorten(example))
  }

  const showsValue = path => LOOKED_FOR.test(path) || /(?:^|\.)key$/.test(path)

  function walk (value, path) {
    if (Array.isArray(value)) {
      const arrayPath = `${path}[]`
      note(arrayPath, 'array', { count: value.length })
      if (isKeyValueList(value)) {
        for (const item of value) {
          const fieldPath = `${path}[${item.key}]`
          const type = item.value === null ? 'null' : typeof item.value
          note(fieldPath, type, LOOKED_FOR.test(item.key) && item.value !== null && typeof item.value !== 'object' ? { example: item.value } : {})
        }
        return
      }
      for (const item of value) {
        if (isRecord(item) || Array.isArray(item)) walk(item, arrayPath)
        else if (item !== null && item !== undefined && showsValue(path)) note(arrayPath, 'array', { example: item })
      }
      return
    }
    if (isRecord(value)) {
      const keys = Object.keys(value)
      if (!keys.length && path) note(path, 'object')
      for (const key of keys) walk(value[key], path ? `${path}.${key}` : key)
      return
    }
    if (!path) return
    if (value === null || value === undefined) note(path, 'null')
    else note(path, typeof value, showsValue(path) ? { example: value } : {})
  }

  walk(root, '')
  return [...entries.values()]
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    .map(({ values, ...entry }) => (values.size ? { ...entry, values: [...values] } : entry))
}

/**
 * @param {{ personIds: number[], paths?: string[], strapi: object, publication: object, xapi?: object|null, log?: object }} options
 *   personIds = Strapi person ids (at most 5); publication / xapi need `getRaw(path)`;
 *   paths = extra endpoints, each "xapi:/path" or "publication:/path" with {personId} (the Fiona person id) and / or
 *   {accreditationId} (read once per accreditation) in it, at most 10
 */
export async function describeFionaFields ({ personIds = [], paths = [], strapi, publication, xapi = null, log = console } = {}) {
  const ids = [...new Set((Array.isArray(personIds) ? personIds : []).map(Number).filter(id => Number.isInteger(id) && id > 0))]
  if (!ids.length) throw new Error('describeFionaFields needs personIds (Strapi person ids)')
  if (ids.length > MAX_PERSONS) throw new Error(`describeFionaFields handles at most ${MAX_PERSONS} persons per call`)
  const extraPaths = (Array.isArray(paths) ? paths : []).map(String)
  if (extraPaths.length > MAX_PATHS) throw new Error(`describeFionaFields reads at most ${MAX_PATHS} paths per call`)
  const extras = extraPaths.map((entry) => {
    const match = /^(xapi|publication):(\/.*)$/.exec(entry)
    if (!match) throw new Error(`describeFionaFields: path "${entry}" must start with xapi: or publication:`)
    return { api: match[1], template: match[2] }
  })

  const result = { persons: [], skipped: [] }
  for (const id of ids) {
    let person
    try {
      person = await strapi.findPersonById(id)
    } catch (err) {
      result.skipped.push({ personId: id, reason: `could not be read: ${err?.message || err}` })
      continue
    }
    if (!person) { result.skipped.push({ personId: id, reason: 'not found' }); continue }
    if (!person.fiona_person_id) { result.skipped.push({ personId: id, reason: 'not managed by the Fiona sync' }); continue }

    const sources = []
    async function read (label, client, path, extra = {}) {
      try {
        sources.push({ source: label, ...extra, fields: outlineFields(await client.getRaw(path)) })
      } catch (err) {
        log.warn?.(`[fiona fields] person #${id} ${label}: ${err?.message || err}`)
        sources.push({ source: label, ...extra, error: err?.message || String(err) })
      }
    }

    const personId = encodeURIComponent(person.fiona_person_id)
    const accreditationIds = splitIds(person.fiona_accreditation_id)
    await read('publication /persons/{personId}', publication, `/persons/${personId}`)
    for (const accreditationId of accreditationIds) {
      await read('publication /accreditations/{id}', publication, `/accreditations/${encodeURIComponent(accreditationId)}`, { accreditationId })
    }
    if (xapi) {
      await read('xapi /person/{personId}', xapi, `/person/${personId}`)
      for (const accreditationId of accreditationIds) {
        await read('xapi /accreditation/{id}', xapi, `/accreditation/${encodeURIComponent(accreditationId)}`, { accreditationId })
      }
    }
    for (const { api, template } of extras) {
      const client = api === 'xapi' ? xapi : publication
      const label = `${api} ${template}`
      const fill = accreditationId => template
        .replaceAll('{personId}', personId)
        .replaceAll('{accreditationId}', encodeURIComponent(accreditationId ?? ''))
      if (!client) { sources.push({ source: label, error: `the ${api} is not configured` }); continue }
      if (template.includes('{accreditationId}')) {
        for (const accreditationId of accreditationIds) await read(label, client, fill(accreditationId), { accreditationId })
      } else {
        await read(label, client, fill())
      }
    }
    result.persons.push({ personId: person.id, name: [person.firstName, person.lastName].filter(Boolean).join(' '), sources })
  }
  return result
}
