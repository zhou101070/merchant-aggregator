import { describe, expect, it } from 'vitest'
import { isShopJob, normalizeJobType } from '../sync'

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
