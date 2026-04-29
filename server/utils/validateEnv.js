export const REQUIRED_ENV_VARS = [
  'NUXT_JWT_SECRET',
  'NUXT_STRAPI_URL',
  'NUXT_STRAPI_USER',
  'NUXT_STRAPI_PASSWORD',
  'NUXT_SYNC_SECRET',
  'NUXT_PUBLIC_URL',
  'NUXT_OAUTH_CLIENT_SECRET'
]

export const OPTIONAL_ENV_VARS = [
  'NUXT_STRAPI_ADMIN_USER',
  'NUXT_STRAPI_ADMIN_PASSWORD',
  'NUXT_PUBLIC_OAUTH_URL',
  'NUXT_PUBLIC_OAUTH_CLIENT_ID',
  'NUXT_PUBLIC_EVENTIVAL_URL',
  'NUXT_PUBLIC_EVENTIVAL_CLIENT_ID',
  'NUXT_EVENTIVAL_CLIENT_SECRET',
  'NUXT_PUBLIC_EVENTIVAL_EDITION',
  'NUXT_EVENTIVAL_API_TOKEN',
  'NUXT_FIONA_API_KEY'
]

export function validateEnvironment() {
  console.log('[validateEnv] Checking required environment variables...')
  const missing = []

  for (const varName of REQUIRED_ENV_VARS) {
    const value = process.env[varName]
    if (!value) {
      missing.push(varName)
      console.warn(`[validateEnv] Missing: ${varName}`)
    } else {
      console.log(`[validateEnv] ✓ ${varName} is set`)
    }
  }

  if (missing.length > 0) {
    const message = [
      '\n❌ Missing required environment variables:',
      missing.map(v => `   - ${v}`).join('\n'),
      '\nSet these vars in .env (local) or docker-compose/system environment.',
      'See .env.docker.local.example for reference.\n'
    ].join('\n')

    console.error(message)
    throw new Error(message)
  }

  console.log('[validateEnv] ✓ All required env vars present')
}
