import { describe, it, expect } from 'vitest'
import { getClientIp } from '../server/utils/clientIp.js'

function makeEvent(headers = {}, remoteAddress = undefined) {
  return {
    node: { req: { socket: remoteAddress ? { remoteAddress } : {} } },
    // getRequestHeaders is globally mocked in setup.js; we replace it per-test
  }
}

// In setup.js, getRequestHeaders is not mocked — add a local shim.
globalThis.getRequestHeaders = (event) => event._headers || {}

function eventWithHeaders(headers, remoteAddress) {
  const e = makeEvent({}, remoteAddress)
  e._headers = headers
  return e
}

describe('getClientIp', () => {
  it('prefers cf-connecting-ip over x-forwarded-for', () => {
    const event = eventWithHeaders({
      'cf-connecting-ip': '1.2.3.4',
      'x-forwarded-for': '9.9.9.9'
    })
    expect(getClientIp(event)).toBe('1.2.3.4')
  })

  it('falls back to first IP in x-forwarded-for when no cf-connecting-ip', () => {
    const event = eventWithHeaders({ 'x-forwarded-for': '10.0.0.1, 10.0.0.2' })
    expect(getClientIp(event)).toBe('10.0.0.1')
  })

  it('falls back to socket remoteAddress when no proxy headers', () => {
    const event = eventWithHeaders({}, '127.0.0.1')
    expect(getClientIp(event)).toBe('127.0.0.1')
  })

  it('returns "unknown" when no IP can be determined', () => {
    const event = eventWithHeaders({})
    expect(getClientIp(event)).toBe('unknown')
  })

  it('strips whitespace from x-forwarded-for entries', () => {
    const event = eventWithHeaders({ 'x-forwarded-for': '  5.5.5.5  , 6.6.6.6' })
    expect(getClientIp(event)).toBe('5.5.5.5')
  })
})
