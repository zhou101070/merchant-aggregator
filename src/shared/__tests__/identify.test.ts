import { describe, expect, it } from 'vitest'
import {
  identifyShopPlatform,
  identityToScrapeRef,
  isIdentityScrapable,
  shopFamilyLabel
} from '../platforms/identify'
import type { ShopSiteProfile } from '../platforms/shop-types'

const disabledLdxp: ShopSiteProfile = {
  id: 'ldxp',
  displayName: '链动小铺',
  family: 'shopapi',
  hosts: ['pay.ldxp.cn', 'ldxp.cn'],
  baseUrl: 'https://pay.ldxp.cn',
  shopPathTemplate: '/shop/{token}',
  itemPathTemplate: '/item/{goodsKey}',
  sourceId: 'ldxp',
  defaultGoodsTypes: ['card'],
  defaultMinIntervalMs: 500,
  enabled: false,
  probeStatus: 'ok'
}

describe('identifyShopPlatform', () => {
  it('identifies ldxp from shop URL', () => {
    const id = identifyShopPlatform({
      shopUrl: 'https://pay.ldxp.cn/shop/PAXOVOVJ'
    })
    expect(id).toMatchObject({
      family: 'shopapi',
      platformId: 'ldxp',
      token: 'PAXOVOVJ',
      scrapeStrategy: 'shopapi',
      scrapable: true,
      source: 'url',
      confidence: 'high'
    })
    expect(isIdentityScrapable(id)).toBe(true)
    expect(identityToScrapeRef(id)).toEqual({ platformId: 'ldxp', token: 'PAXOVOVJ' })
  })

  it('identifies catfk from entry URL', () => {
    const id = identifyShopPlatform({
      entryUrl: 'https://catfk.com/shop/hththt'
    })
    expect(id.platformId).toBe('catfk')
    expect(id.scrapable).toBe(true)
    expect(id.scrapeStrategy).toBe('shopapi')
  })

  it('uses stored platform+token when URL missing', () => {
    const id = identifyShopPlatform({
      shopPlatform: 'catfk',
      shopToken: 'abc123'
    })
    expect(id).toMatchObject({
      platformId: 'catfk',
      token: 'abc123',
      source: 'stored_ref',
      scrapable: true
    })
  })

  it('legacy ldxp_token without platform', () => {
    const id = identifyShopPlatform({ ldxpToken: 'LEGACY1' })
    expect(id).toMatchObject({
      platformId: 'ldxp',
      token: 'LEGACY1',
      source: 'legacy_ldxp',
      scrapable: true
    })
  })

  it('maps dujiao collector_kind + host as scrapable', () => {
    const id = identifyShopPlatform({
      host: 'ultra.makelove.cloud',
      collectorKind: 'dujiao',
      shopUrl: 'https://ultra.makelove.cloud/'
    })
    expect(id).toMatchObject({
      family: 'dujiao',
      platformId: 'dujiao',
      token: 'ultra.makelove.cloud',
      scrapeStrategy: 'dujiao',
      scrapable: true,
      source: 'collector_kind',
      confidence: 'high'
    })
    expect(isIdentityScrapable(id)).toBe(true)
    expect(identityToScrapeRef(id)).toEqual({
      platformId: 'dujiao',
      token: 'ultra.makelove.cloud'
    })
  })

  it('dujiao without host is not scrapable', () => {
    const id = identifyShopPlatform({ collectorKind: 'dujiao' })
    expect(id.family).toBe('dujiao')
    expect(id.scrapable).toBe(false)
    expect(id.reason).toMatch(/host/)
  })

  it('stored dujiao platform+host token', () => {
    const id = identifyShopPlatform({
      shopPlatform: 'dujiao',
      shopToken: 'FlyAI.qzz.io'
    })
    expect(id).toMatchObject({
      platformId: 'dujiao',
      token: 'flyai.qzz.io',
      scrapeStrategy: 'dujiao',
      scrapable: true,
      source: 'stored_ref'
    })
  })

  it('kami + host without path hint is candidate only (not scrapable)', () => {
    const id = identifyShopPlatform({
      host: 'web3chirou.com',
      collectorKind: 'kami',
      shopUrl: 'https://web3chirou.com/'
    })
    expect(id).toMatchObject({
      family: 'yiciyuan',
      platformId: 'yiciyuan',
      token: 'web3chirou.com',
      scrapeStrategy: 'yiciyuan',
      scrapable: false,
      source: 'collector_kind',
      confidence: 'medium'
    })
    expect(isIdentityScrapable(id)).toBe(false)
    expect(identityToScrapeRef(id)).toBeNull()
  })

  it('kami + /item/ path hint is scrapable', () => {
    const id = identifyShopPlatform({
      host: 'wiki123.top',
      collectorKind: 'kami',
      entryUrl: 'https://wiki123.top/item/8'
    })
    expect(id).toMatchObject({
      family: 'yiciyuan',
      platformId: 'yiciyuan',
      token: 'wiki123.top',
      scrapable: true,
      confidence: 'high'
    })
    expect(identityToScrapeRef(id)).toEqual({
      platformId: 'yiciyuan',
      token: 'wiki123.top'
    })
  })

  it('kami without host is not scrapable', () => {
    const id = identifyShopPlatform({ collectorKind: 'kami' })
    expect(id.family).toBe('yiciyuan')
    expect(id.scrapable).toBe(false)
    expect(id.reason).toMatch(/host/)
  })

  it('stored yiciyuan platform is scrapable', () => {
    const id = identifyShopPlatform({
      shopPlatform: 'yiciyuan',
      shopToken: 'Web3chirou.com'
    })
    expect(id).toMatchObject({
      platformId: 'yiciyuan',
      token: 'web3chirou.com',
      scrapeStrategy: 'yiciyuan',
      scrapable: true
    })
  })

  it('stored kami without path hint is not scrapable', () => {
    const id = identifyShopPlatform({
      shopPlatform: 'kami',
      shopToken: 'lynnzee.myweb999.cfd'
    })
    expect(id.scrapable).toBe(false)
    expect(identityToScrapeRef(id)).toBeNull()
  })

  it('shopApi collector without URL is not scrapable', () => {
    const id = identifyShopPlatform({ collectorKind: 'shopApi' })
    expect(id.family).toBe('shopapi')
    expect(id.scrapable).toBe(false)
    expect(id.reason).toMatch(/缺少|URL|token/)
  })

  it('URL wins over collector_kind', () => {
    const id = identifyShopPlatform({
      shopUrl: 'https://pay.ldxp.cn/shop/ABC',
      collectorKind: 'dujiao'
    })
    expect(id.platformId).toBe('ldxp')
    expect(id.source).toBe('url')
    expect(id.scrapable).toBe(true)
  })

  it('disabled profile is recognized but not scrapable', () => {
    const id = identifyShopPlatform({ shopUrl: 'https://pay.ldxp.cn/shop/ABC' }, [disabledLdxp])
    expect(id.platformId).toBe('ldxp')
    expect(id.profileEnabled).toBe(false)
    expect(id.scrapable).toBe(false)
    expect(isIdentityScrapable(id)).toBe(false)
    // Still yields ref so sync can surface PAUSED at adapter layer
    expect(identityToScrapeRef(id)).toEqual({ platformId: 'ldxp', token: 'ABC' })
    expect(id.reason).toMatch(/暂停/)
  })

  it('unknown when nothing matches', () => {
    const id = identifyShopPlatform({ host: 'example.com' })
    expect(id.family).toBe('unknown')
    expect(id.scrapable).toBe(false)
    expect(id.source).toBe('none')
  })

  it('unknown stored platform not in registry', () => {
    const id = identifyShopPlatform({
      shopPlatform: 'mystery',
      shopToken: 'tok'
    })
    expect(id.family).toBe('unknown')
    expect(id.platformId).toBe('mystery')
    expect(id.scrapable).toBe(false)
  })
})

describe('shopFamilyLabel', () => {
  it('returns Chinese labels', () => {
    expect(shopFamilyLabel('dujiao')).toBe('独角数卡')
    expect(shopFamilyLabel('yiciyuan')).toBe('异次元发卡')
    expect(shopFamilyLabel('shopapi')).toContain('shopApi')
  })
})
