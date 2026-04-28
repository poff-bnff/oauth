import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const { version } = JSON.parse(readFileSync(resolve('./package.json'), 'utf-8'))

export default defineEventHandler((event) => {
  setHeader(event, 'Cache-Control', 'no-store')
  return {
    status: 'ok',
    timestamp: new Date().toISOString(),
    version
  }
})
