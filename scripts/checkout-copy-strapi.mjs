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
    process.env.NUXT_STRAPI_URL ||
    process.env.STRAPI_URL ||
    composeStrapiUrl()
  )
  const identifier = process.env.NUXT_STRAPI_USER ||
    process.env.STRAPI_USER ||
    process.env.StrapiUserName ||
    process.env.StrapiUser ||
    process.env.STRAPI_USERNAME
  const password = process.env.NUXT_STRAPI_PASSWORD ||
    process.env.STRAPI_PASSWORD ||
    process.env.StrapiPassword

  return { baseUrl, identifier, password }
}

export async function getStrapiToken({ baseUrl, identifier, password }) {
  if (!baseUrl || !identifier || !password) {
    throw new Error('Missing Strapi URL or credentials')
  }

  const data = await fetchJson(`${baseUrl}/auth/local`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ identifier, password })
  })

  if (!data?.jwt) throw new Error('Strapi login did not return jwt')
  return data.jwt
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

export async function upsertCheckoutLabelGroup(baseUrl, token, payload) {
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

  if (existingGroup?.id) {
    return fetchJson(`${baseUrl}/label-groups/${existingGroup.id}`, {
      method: 'PUT',
      headers,
      body: JSON.stringify(payload)
    })
  }

  return fetchJson(`${baseUrl}/label-groups`, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload)
  })
}

async function fetchJson(url, options = {}) {
  const response = await request(url, options)
  const text = response.text
  const data = text ? JSON.parse(text) : null

  if (response.status < 200 || response.status >= 300) {
    const message = data?.message || data?.error || text || response.statusText
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
