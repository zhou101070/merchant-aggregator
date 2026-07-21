import { describe, expect, it } from 'vitest'
import {
  canSyncShopProducts,
  canTrialUnknownShopSync,
  resolveShopSyncStartRef
} from '../shop-ref'

describe('unknown shop trial UI helpers', () => {
  it('allows trial when host present but platform unknown', () => {
    const m = {
      host: 'weird-shop.example.com',
      shopUrl: 'https://weird-shop.example.com/',
      shopPlatform: null,
      shopToken: null
    }
    expect(canTrialUnknownShopSync(m)).toBe(true)
    expect(canSyncShopProducts(m)).toBe(true)
    expect(resolveShopSyncStartRef({ ...m, merchantId: 'm1' })).toEqual({
      platformId: 'unknown',
      token: 'weird-shop.example.com',
      merchantId: 'm1'
    })
  })

  it('does not trial known scrapable ldxp', () => {
    const m = {
      shopPlatform: 'ldxp',
      shopToken: 'PAXOVOVJ'
    }
    expect(canTrialUnknownShopSync(m)).toBe(false)
    expect(canSyncShopProducts(m)).toBe(true)
    expect(resolveShopSyncStartRef(m)).toEqual({
      platformId: 'ldxp',
      token: 'PAXOVOVJ',
      merchantId: undefined
    })
  })

  it('returns null when nothing to trial', () => {
    const m = { shopPlatform: null, shopToken: null, host: null }
    expect(canTrialUnknownShopSync(m)).toBe(false)
    expect(canSyncShopProducts(m)).toBe(false)
    expect(resolveShopSyncStartRef(m)).toBeNull()
  })
})
