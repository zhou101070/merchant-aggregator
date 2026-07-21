import { describe, expect, it } from 'vitest'
import {
  formatErrorDetailsSummary,
  formatErrorWithDetails,
  primaryErrorCode
} from '../error-format'

describe('primaryErrorCode', () => {
  it('returns null for empty', () => {
    expect(primaryErrorCode([])).toBe(null)
  })

  it('returns the only code', () => {
    expect(primaryErrorCode([{ code: 'TIMEOUT' }])).toBe('TIMEOUT')
  })

  it('picks most frequent', () => {
    expect(
      primaryErrorCode([
        { code: 'NETWORK' },
        { code: 'NETWORK' },
        { code: 'NEED_BROWSER' }
      ])
    ).toBe('NETWORK')
  })

  it('tie-breaks toward NEED_BROWSER over NETWORK', () => {
    expect(
      primaryErrorCode([
        { code: 'NETWORK' },
        { code: 'NEED_BROWSER' }
      ])
    ).toBe('NEED_BROWSER')
  })

  it('defaults missing code to INTERNAL', () => {
    expect(primaryErrorCode([{}])).toBe('INTERNAL')
  })
})

describe('formatErrorDetailsSummary', () => {
  it('summarizes known keys', () => {
    expect(
      formatErrorDetailsSummary({
        status: 502,
        path: '/shopApi/Shop/info',
        snippet: 'Bad Gateway'
      })
    ).toBe('status=502 · path=/shopApi/Shop/info · snippet=Bad Gateway')
  })

  it('returns null for empty object', () => {
    expect(formatErrorDetailsSummary({})).toBe(null)
  })
})

describe('formatErrorWithDetails', () => {
  it('appends summary', () => {
    expect(formatErrorWithDetails('shop HTTP 502', { status: 502, path: '/x' })).toBe(
      'shop HTTP 502 · status=502 · path=/x'
    )
  })
})
