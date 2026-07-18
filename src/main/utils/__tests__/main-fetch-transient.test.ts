import { describe, expect, it } from 'vitest'
import { isTransientNetworkError } from '../main-fetch'

describe('isTransientNetworkError', () => {
  it('detects chromium connection closed / ssl handshake noise', () => {
    expect(
      isTransientNetworkError(
        new Error('net::ERR_CONNECTION_CLOSED')
      )
    ).toBe(true)
    expect(
      isTransientNetworkError(
        new Error('handshake failed; returned -1, SSL error code 1, net_error -100')
      )
    ).toBe(true)
    expect(isTransientNetworkError(new Error('net::ERR_SSL_PROTOCOL_ERROR'))).toBe(true)
    expect(isTransientNetworkError(new Error('socket hang up'))).toBe(true)
  })

  it('does not treat abort or ordinary app errors as transient', () => {
    const abort = new Error('aborted')
    abort.name = 'AbortError'
    expect(isTransientNetworkError(abort)).toBe(false)
    expect(isTransientNetworkError(new Error('HTTP 404'))).toBe(false)
    expect(isTransientNetworkError(new Error('invalid JSON'))).toBe(false)
  })
})
