/**
 * authenticateStrapiUser — finds (or creates) the Strapi user of a login e-mail. It now times its parts by name (the service token,
 * the lookup by e-mail, and for an alias login the read of its main account), so the slow one can be seen in the login timings.
 */
import { describe, it, expect, vi } from 'vitest'
import jwt from 'jsonwebtoken'
import { authenticateStrapiUser } from '../server/utils/strapi.js'

const SERVICE_TOKEN = jwt.sign({ id: 16998 }, 'test-secret', { expiresIn: '1h' })

function namesOf (run) {
  const names = []
  const timer = { step: (name, fn) => { names.push(name); return fn() }, detail: () => {} }
  return run(timer).then(() => names)
}

function mockStrapi ({ found }) {
  globalThis.$fetch = vi.fn().mockImplementation((url) => {
    if (url.endsWith('/auth/local')) return { jwt: SERVICE_TOKEN }
    if (url.includes('/users?email=')) return found
    throw new Error(`unexpected ${url}`)
  })
}

describe('authenticateStrapiUser timings', () => {
  it('times the service token and the lookup by e-mail for a user that has no main account', async () => {
    mockStrapi({ found: [{ id: 5, email: 'a@example.ee', aliasUsers: [], user_profile: {} }] })

    const names = await namesOf(timer => authenticateStrapiUser('a@example.ee', { timer }))

    expect(names).toEqual(['auth › service token (Strapi)', 'auth › find user by e-mail (Strapi)'])
  })

  it('works without a timer', async () => {
    mockStrapi({ found: [{ id: 5, email: 'a@example.ee', aliasUsers: [], user_profile: {} }] })

    const user = await authenticateStrapiUser('a@example.ee')

    expect(user).toBeTruthy()
  })
})
