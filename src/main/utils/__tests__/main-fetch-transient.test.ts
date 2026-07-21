import { describe, expect, it } from 'vitest'
import { isTransientNetworkError, mergeAbortSignals } from '../main-fetch'

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

describe('mergeAbortSignals', () => {
  it('returns undefined when no signals given', () => {
    expect(mergeAbortSignals()).toBeUndefined()
    expect(mergeAbortSignals(null, undefined)).toBeUndefined()
  })

  it('returns the single signal as-is', () => {
    const c = new AbortController()
    expect(mergeAbortSignals(c.signal)).toBe(c.signal)
  })

  it('aborts when either input aborts', () => {
    const a = new AbortController()
    const b = new AbortController()
    const merged = mergeAbortSignals(a.signal, b.signal)
    expect(merged?.aborted).toBe(false)
    b.abort()
    expect(merged?.aborted).toBe(true)
  })
})
