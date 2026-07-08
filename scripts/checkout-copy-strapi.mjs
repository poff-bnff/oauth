import { mkdir, readFile, writeFile } from 'node:fs/promises'
import http from 'node:http'
import https from 'node:https'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const projectRoot = resolve(__dirname, '..')

export const checkoutCopyOutputPath = resolve(projectRoot, 'generated/checkoutCopy.json')
export const checkoutCopyDefaultsPath = resolve(projectRoot, 'utils/checkoutCopyDefaults.json')
export const CHECKOUT_COPY_GROUP_NAMES = [
  'oauthCheckout',
  'oauth-checkout',
  'checkoutCopy',
  'checkout-copy'
]
export const CHECKOUT_COPY_LOCALES = ['en', 'et', 'ru']

export async function readCheckoutCopyDefaults() {
  return JSON.parse(await readFile(checkoutCopyDefaultsPath, 'utf8'))
}

export async function writeCheckoutCopyOverrides(overrides) {
  await mkdir(dirname(checkoutCopyOutputPath), { recursive: true })
  await writeFile(checkoutCopyOutputPath, `${JSON.stringify(overrides || {}, null, 2)}\n`)
}

export async function loadLocalEnv() {
  for (const fileName of ['.env', '.env.local', '.env.docker.local']) {
    await loadEnvFile(resolve(projectRoot, fileName))
  }
}

export function getStrapiConfig() {
  const baseUrl = normalizeBaseUrl(
    process.env.CHECKOUT_COPY_STRAPI_URL ||
    process.env.NUXT_STRAPI_URL ||
    process.env.STRAPI_URL ||
    composeStrapiUrl()
  )
  const identifier = process.env.CHECKOUT_COPY_STRAPI_USER ||
    process.env.NUXT_STRAPI_USER ||
    process.env.STRAPI_USER ||
    process.env.StrapiUserName ||
    process.env.StrapiUser ||
    process.env.STRAPI_USERNAME
  const password = process.env.CHECKOUT_COPY_STRAPI_PASSWORD ||
    process.env.NUXT_STRAPI_PASSWORD ||
    process.env.STRAPI_PASSWORD ||
    process.env.StrapiPassword
  const adminEmail = process.env.CHECKOUT_COPY_STRAPI_ADMIN_USER ||
    process.env.NUXT_STRAPI_ADMIN_USER ||
    process.env.STRAPI_ADMIN_USER
  const adminPassword = process.env.CHECKOUT_COPY_STRAPI_ADMIN_PASSWORD ||
    process.env.NUXT_STRAPI_ADMIN_PASSWORD ||
    process.env.STRAPI_ADMIN_PASSWORD

  return { baseUrl, identifier, password, adminEmail, adminPassword }
}

export async function getStrapiToken({ baseUrl, identifier, password }) {
  if (!baseUrl || !identifier || !password) {
    throw new Error(
      'Missing Strapi URL or content API credentials. ' +
      'Use CHECKOUT_COPY_STRAPI_USER/PASSWORD or NUXT_STRAPI_USER/PASSWORD. ' +
      'Strapi admin-panel credentials do not work with /auth/local.'
    )
  }

  const data = await fetchJson(`${baseUrl}/auth/local`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ identifier, password })
  })

  if (!data?.jwt) throw new Error('Strapi login did not return jwt')
  return data.jwt
}

export async function getStrapiAdminToken({ baseUrl, adminEmail, adminPassword }) {
  if (!baseUrl || !adminEmail || !adminPassword) {
    throw new Error(
      'Missing Strapi admin credentials. ' +
      'Use NUXT_STRAPI_ADMIN_USER/PASSWORD or CHECKOUT_COPY_STRAPI_ADMIN_USER/PASSWORD.'
    )
  }

  const data = await fetchJson(`${baseUrl}/admin/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: adminEmail, password: adminPassword })
  })

  const token = data?.data?.token
  if (!token) throw new Error('Strapi admin login did not return token')
  return token
}

export async function fetchCheckoutLabelGroups(baseUrl, token) {
  const headers = token ? { authorization: `Bearer ${token}` } : {}
  const encodedNames = CHECKOUT_COPY_GROUP_NAMES
    .map(name => `name_in=${encodeURIComponent(name)}`)
    .join('&')
  const firstPass = await fetchJson(`${baseUrl}/label-groups?_limit=20&${encodedNames}`, { headers })
    .catch(() => null)

  if (Array.isArray(firstPass) && firstPass.length) return firstPass
  if (Array.isArray(firstPass?.data) && firstPass.data.length) return firstPass

  return fetchJson(`${baseUrl}/label-groups?_limit=-1`, { headers })
}

export function normalizeCheckoutLabelGroups(labelGroups) {
  const groups = Array.isArray(labelGroups)
    ? labelGroups
    : Array.isArray(labelGroups?.data)
      ? labelGroups.data
      : []
  const checkoutGroup = unwrapStrapiEntity(groups.find(isCheckoutCopyGroup))
  const labels = checkoutGroup?.label || checkoutGroup?.labels || []
  if (!Array.isArray(labels)) return {}

  return labels.reduce((copy, label) => {
    const unwrappedLabel = unwrapStrapiEntity(label)
    const name = firstText(unwrappedLabel?.name, unwrappedLabel?.key, unwrappedLabel?.code)
    if (!name) return copy

    for (const locale of CHECKOUT_COPY_LOCALES) {
      const value = localizedLabelValue(unwrappedLabel, locale)
      if (value) copy[locale][name] = value
    }

    return copy
  }, emptyCopy())
}

export function checkoutLabelPayload(defaults) {
  const keys = Object.keys(defaults?.en || {}).sort()
  return {
    name: 'oauthCheckout',
    label: keys.map(name => ({
      name,
      value_en: stringifyLabelValue(defaults.en?.[name]),
      value_et: stringifyLabelValue(defaults.et?.[name] || defaults.en?.[name]),
      value_ru: stringifyLabelValue(defaults.ru?.[name] || defaults.en?.[name])
    }))
  }
}

export function mergeCheckoutLabels(existingLabels, seedLabels, { overwrite = false } = {}) {
  const existing = Array.isArray(existingLabels) ? existingLabels.slice() : []
  const byName = new Map()
  for (const label of existing) {
    const unwrapped = unwrapStrapiEntity(label)
    if (unwrapped?.name) byName.set(unwrapped.name, label)
  }

  const nextLabels = existing.slice()
  const added = []
  const updated = []

  for (const seed of seedLabels) {
    const current = byName.get(seed.name)
    if (!current) {
      nextLabels.push(seed)
      added.push(seed.name)
      continue
    }

    const unwrapped = unwrapStrapiEntity(current)
    const merged = overwrite
      ? { value_en: seed.value_en, value_et: seed.value_et, value_ru: seed.value_ru }
      : {
          value_en: unwrapped.value_en || seed.value_en,
          value_et: unwrapped.value_et || seed.value_et,
          value_ru: unwrapped.value_ru || seed.value_ru
        }
    const changed = ['value_en', 'value_et', 'value_ru'].some(key => merged[key] !== unwrapped[key])
    if (changed) {
      Object.assign(current, merged)
      updated.push(seed.name)
    }
  }

  return { nextLabels, added, updated }
}

export async function upsertCheckoutLabelGroup(baseUrl, token, payload, options = {}) {
  const overwrite = options.overwrite ?? (process.env.CHECKOUT_COPY_LABELS_OVERWRITE === '1')
  const dryRun = options.dryRun ?? (process.env.CHECKOUT_COPY_LABELS_DRY_RUN === '1')
  const headers = {
    authorization: `Bearer ${token}`,
    'content-type': 'application/json'
  }
  const existingGroups = await fetchCheckoutLabelGroups(baseUrl, token)
  const groups = Array.isArray(existingGroups)
    ? existingGroups
    : Array.isArray(existingGroups?.data)
      ? existingGroups.data
      : []
  const existingGroup = groups.map(unwrapStrapiEntity).find(isCheckoutCopyGroup)

  if (!existingGroup?.id) {
    console.log(`Label group "${payload.name}" not found. ${dryRun ? 'Would create' : 'Creating'} with ${payload.label.length} labels.`)
    if (dryRun) return { name: payload.name, label: payload.label, dryRun: true }
    return fetchJson(`${baseUrl}/label-groups`, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload)
    })
  }

  const existingLabels = Array.isArray(existingGroup.label) ? existingGroup.label : []
  const { nextLabels, added, updated } = mergeCheckoutLabels(existingLabels, payload.label, { overwrite })

  console.log(overwrite ? 'Mode: overwrite existing values' : 'Mode: add missing labels / fill empty values only')
  console.log(`Existing labels: ${existingLabels.length}`)
  console.log(`Missing labels ${dryRun ? 'that would be added' : 'added'}: ${added.length ? added.join(', ') : '(none)'}`)
  console.log(`Labels ${dryRun ? 'that would be updated' : 'updated'}: ${updated.length ? updated.join(', ') : '(none)'}`)

  if (!added.length && !updated.length) {
    console.log('No changes needed.')
    return existingGroup
  }

  if (dryRun) return { ...existingGroup, label: nextLabels, dryRun: true }

  return fetchJson(`${baseUrl}/label-groups/${existingGroup.id}`, {
    method: 'PUT',
    headers,
    body: JSON.stringify({ name: existingGroup.name || payload.name, label: nextLabels })
  })
}

async function fetchJson(url, options = {}) {
  const response = await request(url, options)
  const text = response.text
  const data = text ? JSON.parse(text) : null

  if (response.status < 200 || response.status >= 300) {
    const message = stringifyErrorMessage(data?.message || data?.error || text || response.statusText)
    throw new Error(`${response.status} ${response.statusText || ''}: ${message}`)
  }

  return data
}

async function request(url, options = {}) {
  if (typeof fetch === 'function') {
    const response = await fetch(url, options)
    return {
      status: response.status,
      statusText: response.statusText,
      text: await response.text()
    }
  }

  return nodeRequest(url, options)
}

function nodeRequest(url, options = {}) {
  return new Promise((resolveRequest, rejectRequest) => {
    const parsedUrl = new URL(url)
    const body = options.body || null
    const transport = parsedUrl.protocol === 'https:' ? https : http
    const requestOptions = {
      method: options.method || 'GET',
      hostname: parsedUrl.hostname,
      port: parsedUrl.port || undefined,
      path: `${parsedUrl.pathname}${parsedUrl.search}`,
      headers: {
        ...(options.headers || {}),
        ...(body ? { 'content-length': Buffer.byteLength(body) } : {})
      }
    }

    const req = transport.request(requestOptions, (res) => {
      let text = ''
      res.setEncoding('utf8')
      res.on('data', chunk => { text += chunk })
      res.on('end', () => {
        resolveRequest({
          status: res.statusCode,
          statusText: res.statusMessage,
          text
        })
      })
    })

    req.on('error', rejectRequest)
    if (body) req.write(body)
    req.end()
  })
}

async function loadEnvFile(filePath) {
  let content = ''
  try {
    content = await readFile(filePath, 'utf8')
  } catch {
    return
  }

  for (const rawLine of content.split('\n')) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#') || !line.includes('=')) continue
    const [key, ...valueParts] = line.split('=')
    if (process.env[key]) continue
    process.env[key] = valueParts.join('=').trim().replace(/^['"]|['"]$/g, '')
  }
}

function composeStrapiUrl() {
  const protocol = process.env.StrapiProtocol
  const host = process.env.StrapiHost
  const port = process.env.StrapiPort
  if (!protocol || !host) return ''
  return `${protocol}://${host}${port ? `:${port}` : ''}`
}

function normalizeBaseUrl(value) {
  return String(value || '').trim().replace(/\/$/, '')
}

function emptyCopy() {
  return { en: {}, et: {}, ru: {} }
}

function normalizeGroupName(value) {
  return String(value || '').trim().toLowerCase().replace(/[-_\s]/g, '')
}

function unwrapStrapiEntity(entity) {
  return entity?.attributes ? { id: entity.id, ...entity.attributes } : entity
}

function isCheckoutCopyGroup(group) {
  const unwrappedGroup = unwrapStrapiEntity(group)
  const name = normalizeGroupName(unwrappedGroup?.name || unwrappedGroup?.slug || unwrappedGroup?.key)
  return CHECKOUT_COPY_GROUP_NAMES.some(groupName => normalizeGroupName(groupName) === name)
}

function localizedLabelValue(label, locale) {
  const titleLocale = locale.charAt(0).toUpperCase() + locale.slice(1)
  return firstText(
    label?.[`value_${locale}`],
    label?.[`value${titleLocale}`],
    label?.value?.[locale],
    label?.[locale],
    label?.value_en,
    label?.valueEn,
    label?.value?.en,
    label?.en,
    label?.value
  )
}

function firstText(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value
  }
  return ''
}

function stringifyLabelValue(value) {
  if (typeof value === 'function') return value({ count: '{count}' })
  return String(value || '')
}

function stringifyErrorMessage(value) {
  if (typeof value === 'string') return value
  if (value === undefined || value === null) return ''
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}
