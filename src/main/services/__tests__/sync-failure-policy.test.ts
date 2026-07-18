import { describe, expect, it } from 'vitest'
import { shouldBlockMerchantAfterSyncFailure } from '../sync-failure-policy'

describe('shouldBlockMerchantAfterSyncFailure', () => {
  it('never blocks when the user setting is disabled', () => {
    expect(
      shouldBlockMerchantAfterSyncFailure({
        enabled: false,
        code: 'NETWORK',
        notFamily: false,
        merchantId: 'm1'
      })
    ).toBe(false)
  })

  it('blocks an ordinary failure only when explicitly enabled', () => {
    expect(
      shouldBlockMerchantAfterSyncFailure({
        enabled: true,
        code: 'NETWORK',
        notFamily: false,
        merchantId: 'm1'
      })
    ).toBe(true)
  })

  it('never blocks cancellations, fingerprint mismatches, or orphan targets', () => {
    expect(
      shouldBlockMerchantAfterSyncFailure({
        enabled: true,
        code: 'CANCELLED',
        notFamily: false,
        merchantId: 'm1'
      })
    ).toBe(false)
    expect(
      shouldBlockMerchantAfterSyncFailure({
        enabled: true,
        code: 'SCHEMA_VALIDATION',
        notFamily: true,
        merchantId: 'm1'
      })
    ).toBe(false)
    expect(
      shouldBlockMerchantAfterSyncFailure({
        enabled: true,
        code: 'NETWORK',
        notFamily: false,
        merchantId: null
      })
    ).toBe(false)
  })
})
