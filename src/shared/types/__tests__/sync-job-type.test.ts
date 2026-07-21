import { describe, expect, it } from 'vitest'
import { isProductSyncActivity, isShopJob, normalizeJobType } from '../sync'

describe('normalizeJobType', () => {
  it('maps legacy aliases to canonical', () => {
    expect(normalizeJobType('ldxp_shop')).toBe('shop_one')
    expect(normalizeJobType('ldxp_selected')).toBe('shop_selected')
    expect(normalizeJobType('ldxp_all')).toBe('shop_all')
  })

  it('accepts canonical types', () => {
    expect(normalizeJobType('merchants')).toBe('merchants')
    expect(normalizeJobType('bootstrap')).toBe('bootstrap')
    expect(normalizeJobType('shop_one')).toBe('shop_one')
  })

  it('returns null for unknown types', () => {
    expect(normalizeJobType('garbage')).toBeNull()
    expect(normalizeJobType('')).toBeNull()
    expect(normalizeJobType('shop_two')).toBeNull()
  })
})

describe('isShopJob', () => {
  it('is true for shop_* and legacy ldxp_*', () => {
    expect(isShopJob('shop_one')).toBe(true)
    expect(isShopJob('ldxp_all')).toBe(true)
  })

  it('is false for merchants/bootstrap/unknown', () => {
    expect(isShopJob('merchants')).toBe(false)
    expect(isShopJob('bootstrap')).toBe(false)
    expect(isShopJob('nope')).toBe(false)
  })
})

describe('isProductSyncActivity', () => {
  it('is true for shop jobs regardless of phase', () => {
    expect(isProductSyncActivity('shop_one', 'starting')).toBe(true)
    expect(isProductSyncActivity('ldxp_all', 'merchants')).toBe(true)
    expect(isProductSyncActivity('shop_selected', 'goods:1:p2')).toBe(true)
  })

  it('bootstrap only after shop phase starts', () => {
    expect(isProductSyncActivity('bootstrap', 'starting')).toBe(false)
    expect(isProductSyncActivity('bootstrap', 'merchants')).toBe(false)
    expect(isProductSyncActivity('bootstrap', 'fingerprint')).toBe(false)
    expect(isProductSyncActivity('bootstrap', 'shop')).toBe(true)
    expect(isProductSyncActivity('bootstrap', 'info')).toBe(true)
    expect(isProductSyncActivity('bootstrap', 'goods:x:p1')).toBe(true)
  })

  it('is false for merchants', () => {
    expect(isProductSyncActivity('merchants', 'merchants')).toBe(false)
  })
})
