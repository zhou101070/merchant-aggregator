import { describe, expect, it } from 'vitest'
import { SHOP_PROFILES } from '../platforms/shop-profiles'
import { parseShopItemKey, parseShopUrl } from '../lib/url-parse'

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

  it('keeps underscore, hyphen, and dot in shop token', () => {
    const r = parseShopUrl('https://pay.ldxp.cn/shop/echo_dream')
    expect(r).toMatchObject({
      platformId: 'ldxp',
      token: 'echo_dream',
      baseUrl: 'https://pay.ldxp.cn',
      profileEnabled: true
    })
    expect(r?.shopUrl).toBe('https://pay.ldxp.cn/shop/echo_dream')
    expect(parseShopUrl('https://pay.ldxp.cn/shop/echo-dream')?.token).toBe('echo-dream')
    const dotted = parseShopUrl('https://pay.ldxp.cn/shop/ai.shop')
    expect(dotted?.token).toBe('ai.shop')
    expect(dotted?.shopUrl).toBe('https://pay.ldxp.cn/shop/ai.shop')
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

  it('does NOT mis-attribute catfk as ldxp', () => {
    expect(parseShopUrl('https://catfk.com/shop/hththt')?.platformId).toBe('catfk')
    expect(parseShopUrl('https://catfk.com/shop/hththt')?.platformId).not.toBe('ldxp')
  })

  it('rejects non-http(s) schemes even with matching host', () => {
    expect(parseShopUrl('javascript://pay.ldxp.cn/shop/ABC123')).toBeNull()
    expect(parseShopUrl('file://pay.ldxp.cn/shop/ABC123')).toBeNull()
    expect(parseShopUrl('data://pay.ldxp.cn/shop/ABC123')).toBeNull()
  })

  it('rejects embedded credentials', () => {
    expect(parseShopUrl('https://user:pass@pay.ldxp.cn/shop/ABC123')).toBeNull()
  })
})

describe('parseShopItemKey', () => {
  it('parses catfk item URL', () => {
    const r = parseShopItemKey('https://catfk.com/item/GOODSKEY1')
    expect(r).toMatchObject({ platformId: 'catfk', goodsKey: 'GOODSKEY1' })
  })

  it('parses ldxp item URL', () => {
    const r = parseShopItemKey('https://pay.ldxp.cn/item/Xy9Z')
    expect(r).toMatchObject({ platformId: 'ldxp', goodsKey: 'Xy9Z' })
  })

  it('keeps underscore and hyphen in goods key', () => {
    expect(parseShopItemKey('https://pay.ldxp.cn/item/ab_cd')?.goodsKey).toBe('ab_cd')
    expect(parseShopItemKey('https://catfk.com/item/ab-cd')?.goodsKey).toBe('ab-cd')
  })

  it('rejects unknown host item URL', () => {
    expect(parseShopItemKey('https://evil.example/item/GOODSKEY1')).toBeNull()
  })

  it('rejects non-url', () => {
    expect(parseShopItemKey('not-a-url')).toBeNull()
  })

  it('rejects non-http(s) item URLs', () => {
    expect(parseShopItemKey('javascript://pay.ldxp.cn/item/Xy9Z')).toBeNull()
    expect(parseShopItemKey('file://catfk.com/item/GOODSKEY1')).toBeNull()
  })
})
