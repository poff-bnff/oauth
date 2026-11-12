/**
 * xapiAccountReport — read-only probe (mode `xapiAccount` with `userIds` and "probe": true): the untouched XAPI record
 * GET /account/details/MyPoff/{userId}/ of a few accounts, for the owner of the account to see what Fiona holds about them.
 * It holds personal data (name, contact details), so the mode refuses to run without "probe": true and answers for at most 3 ids.
 */
import { describe, it, expect } from 'vitest'
import { xapiAccountReport } from '../server/utils/fiona/xapiAccountReport.js'

const status = code => Object.assign(new Error(`[GET] "…": ${code} Whatever`), { statusCode: code })

function fakeXapi (routes) {
  const asked = []
  return {
    asked,
    getRaw: (path) => {
      asked.push(path)
      const route = routes[path]
      if (route === undefined) return Promise.reject(status(404))
      return route instanceof Error ? Promise.reject(route) : Promise.resolve(route)
    }
  }
}

describe('xapiAccountReport', () => {
  it('returns the untouched record of each account under its user id', async () => {
    const record = { Person: { Id: 'p-1', FirstName: 'Jaan' }, AccountGroups: [] }
    const xapi = fakeXapi({ '/account/details/MyPoff/22135/': record })

    const result = await xapiAccountReport({ userIds: [22135], xapi })

    expect(result).toEqual({ accounts: [{ userId: '22135', found: true, record }] })
    expect(xapi.asked).toEqual(['/account/details/MyPoff/22135/'])
  })

  it('says "no account" for a 404 or 400 and reports any other failure without a record', async () => {
    const xapi = fakeXapi({ '/account/details/MyPoff/2/': status(400), '/account/details/MyPoff/3/': status(504) })

    const { accounts } = await xapiAccountReport({ userIds: [1, 2, 3], xapi })

    expect(accounts).toEqual([
      { userId: '1', found: false },
      { userId: '2', found: false },
      { userId: '3', found: null, error: '[GET] "…": 504 Whatever' }
    ])
  })

  it('answers for at most three ids, each once, and skips blanks', async () => {
    const xapi = fakeXapi({})

    const { accounts } = await xapiAccountReport({ userIds: [5, 5, null, '', 0, 6, 7, 8, 9], xapi })

    expect(accounts.map(account => account.userId)).toEqual(['5', '6', '7'])
    expect(xapi.asked).toHaveLength(3)
  })

  it('encodes the id it puts in the path and copes with a missing list', async () => {
    const xapi = fakeXapi({})

    await xapiAccountReport({ userIds: ['a/b'], xapi })
    expect(xapi.asked).toEqual(['/account/details/MyPoff/a%2Fb/'])
    expect(await xapiAccountReport({ xapi: fakeXapi({}) })).toEqual({ accounts: [] })
  })
})
