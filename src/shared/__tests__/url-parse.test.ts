import { describe, expect, it } from 'vitest'
import { SHOP_PROFILES } from '../platforms/shop-profiles'
import {
  parseLdxpItemKey,
  parseLdxpShopToken,
  parseShopItemKey,
  parseShopUrl
} from '../lib/url-parse'

describe('parseShopUrl', () => {
  it('parses catfk shop URL', () => {
    const r = parseShopUrl('https://catfk.com/shop/hththt')
    expect(r).toMatchObject({
      platformId: 'catfk',
      token: 'hththt',
      baseUrl: 'https://catfk.com',
      profileEnabled: true
    })
    expect(r?.shopUrl).toBe('https://catfk.com/shop/hththt')
  })

  it('parses ldxp shop URL', () => {
    const r = parseShopUrl('https://pay.ldxp.cn/shop/EXZMM8SQ')
    expect(r).toMatchObject({
      platformId: 'ldxp',
      token: 'EXZMM8SQ',
      baseUrl: 'https://pay.ldxp.cn',
      profileEnabled: true
    })
  })

  it('rejects unknown host', () => {
    expect(parseShopUrl('https://evil.example/shop/ABC123')).toBeNull()
  })

  it('rejects path-only shop path without host', () => {
    expect(parseShopUrl('/shop/hththt')).toBeNull()
  })

  it('rejects bare token', () => {
    expect(parseShopUrl('hththt')).toBeNull()
  })

  it('uses all registered profiles including disabled', () => {
    const catfk = SHOP_PROFILES.find((p) => p.id === 'catfk')
    expect(catfk?.enabled).toBe(true)
    expect(parseShopUrl('https://www.catfk.com/shop/hththt')?.platformId).toBe('catfk')
  })
})

describe('parseLdxpShopToken (compat + bugfix)', () => {
  it('extracts token from ldxp URL', () => {
    expect(parseLdxpShopToken('https://pay.ldxp.cn/shop/EXZMM8SQ')).toBe('EXZMM8SQ')
  })

  it('accepts bare token for legacy callers', () => {
    expect(parseLdxpShopToken('EXZMM8SQ')).toBe('EXZMM8SQ')
  })

  it('does NOT treat catfk shop URL as ldxp token (wrong-platform bugfix)', () => {
    expect(parseLdxpShopToken('https://catfk.com/shop/hththt')).toBeNull()
  })

  it('rejects unknown host /shop/ paths', () => {
    expect(parseLdxpShopToken('https://evil.example/shop/ABC12345')).toBeNull()
  })

  it('rejects path-only /shop/ without host', () => {
    expect(parseLdxpShopToken('/shop/EXZMM8SQ')).toBeNull()
  })
})

describe('parseShopItemKey', () => {
  it('parses catfk item URL', () => {
    const r = parseShopItemKey('https://catfk.com/item/GOODSKEY1')
    expect(r).toMatchObject({ platformId: 'catfk', goodsKey: 'GOODSKEY1' })
  })

  it('parseLdxpItemKey ignores non-ldxp hosts', () => {
    expect(parseLdxpItemKey('https://catfk.com/item/GOODSKEY1')).toBeNull()
  })
})
