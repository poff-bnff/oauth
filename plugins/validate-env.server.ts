import { validateEnvironment } from '~/server/utils/validateEnv'

export default defineNitroPlugin(() => {
  validateEnvironment()
})
