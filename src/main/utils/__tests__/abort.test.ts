import { describe, expect, it } from 'vitest'
import { AppError } from '@shared/types/errors'
import { abortError, appErrorFromAbort, isAbortError, mapAbortError } from '../abort'

describe('abort helpers', () => {
  it('detects AbortError and aborted message', () => {
    expect(isAbortError(abortError())).toBe(true)
    expect(isAbortError(new Error('The user aborted a request'))).toBe(true)
    expect(isAbortError(new Error('network down'))).toBe(false)
    expect(isAbortError(new AppError('TIMEOUT', 'x'))).toBe(false)
  })

  it('maps abort to CANCELLED only when signal aborted', () => {
    const ac = new AbortController()
    expect(appErrorFromAbort(ac.signal, 'shop request').code).toBe('TIMEOUT')
    ac.abort()
    expect(appErrorFromAbort(ac.signal, 'shop request').code).toBe('CANCELLED')
    expect(appErrorFromAbort(undefined, 'shop request').code).toBe('TIMEOUT')
  })

  it('mapAbortError preserves AppError and remaps abort', () => {
    const timeout = new AppError('TIMEOUT', 'request timeout')
    expect(mapAbortError(timeout, undefined, 'x')).toBe(timeout)

    const ac = new AbortController()
    const mapped = mapAbortError(abortError(), ac.signal, 'shop request')
    expect(mapped).toMatchObject({ code: 'TIMEOUT' })
    ac.abort()
    expect(mapAbortError(abortError(), ac.signal, 'shop request')).toMatchObject({
      code: 'CANCELLED'
    })
  })
})
