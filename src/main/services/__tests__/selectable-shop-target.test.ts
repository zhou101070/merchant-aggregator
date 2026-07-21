import { describe, expect, it } from 'vitest'
import { enabledScrapablePlatformIds } from '@shared/platforms/shop-profiles'
import { isSelectableShopTarget } from '../sync-orchestrator'

const enabled = enabledScrapablePlatformIds()

describe('isSelectableShopTarget', () => {
  it('keeps known enabled platforms', () => {
    expect(
      isSelectableShopTarget(
        { platformId: 'ldxp', token: 'ABC', merchantId: 'm1' },
        enabled
      )
    ).toBe(true)
    expect(
      isSelectableShopTarget(
        { platformId: 'dujiao', token: 'shop.example.com', merchantId: 'm2' },
        enabled
      )
    ).toBe(true)
  })

  it('keeps unknown-platform trial targets (not in enabledIds)', () => {
    expect(
      isSelectableShopTarget(
        {
          platformId: 'unknown',
          token: 'mystery.example.com',
          merchantId: 'm3',
          trialUnknownPlatform: true
        },
        enabled
      )
    ).toBe(true)
    // Without trial flag, unregistered platformId must not slip into batch sync
    expect(
      isSelectableShopTarget(
        { platformId: 'unknown', token: 'mystery.example.com', merchantId: 'm3' },
        enabled
      )
    ).toBe(false)
  })

  it('drops empty / null targets', () => {
    expect(isSelectableShopTarget(null, enabled)).toBe(false)
    expect(isSelectableShopTarget({ platformId: '', token: '', merchantId: null }, enabled)).toBe(
      false
    )
  })
})
