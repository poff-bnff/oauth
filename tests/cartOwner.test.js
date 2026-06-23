import { describe, it, expect, beforeEach } from 'vitest'

// A mangled request (e.g. a proxy/extension sending a duplicated header as an array) must never
// throw out of getCartOwner and 500 the add endpoint — it should degrade to guest/null.
describe('getCartOwner — robust to mangled headers (no 500)', () => {
  let getCartOwner
  beforeEach(async () => {
    ({ getCartOwner } = await import('../server/utils/strapi.js'))
  })
  const withHeaders = (headers) => { globalThis.getRequestHeaders = () => headers; return {} }

  it('does not throw when authorization is a duplicated (array) header', () => {
    expect(() => getCartOwner(withHeaders({ authorization: ['Bearer aaa', 'Bearer bbb'] }))).not.toThrow()
  })

  it('uses the first x-cart-token when it arrives as an array', () => {
    expect(getCartOwner(withHeaders({ 'x-cart-token': ['tok-1', 'tok-2'] }))).toEqual({ cartToken: 'tok-1' })
  })

  it('returns null when there is no usable auth or cart token', () => {
    expect(getCartOwner(withHeaders({}))).toBeNull()
  })
})
