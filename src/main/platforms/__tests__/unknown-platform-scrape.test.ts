import { beforeEach, describe, expect, it, vi } from 'vitest'
import { AppError } from '@shared/types/errors'
import {
  canBuildUnknownTrialTarget,
  isSilentUnknownFailure,
  shopApiTokenCandidate,
  shouldTrialUnknownPlatform,
  trialHostOf,
  scrapeUnknownPlatformTrials
} from '../unknown-platform-scrape'
import type { ShopIdentity } from '@shared/platforms/identify'
import type { ShopScrapeTarget } from '../registry'

const scrapeShopApi = vi.fn(async () => {
  throw new AppError('NOT_FOUND', 'shopapi miss')
})
const scrapeDujiao = vi.fn(async () => {
  throw new AppError('NOT_FOUND', 'dujiao miss')
})
const scrapeYiciyuan = vi.fn(async () => {
  throw new AppError('NOT_FOUND', 'yiciyuan miss')
})
const scrapeAutopixel = vi.fn(async () => {
  throw new AppError('NOT_FOUND', 'autopixel miss')
})

vi.mock('../shopapi/scraper', () => ({
  scrapeShopApi: (...args: unknown[]) => scrapeShopApi(...args)
}))

vi.mock('../dujiao/scraper', () => ({
  scrapeDujiao: (...args: unknown[]) => scrapeDujiao(...args)
}))

vi.mock('../yiciyuan/scraper', () => ({
  scrapeYiciyuan: (...args: unknown[]) => scrapeYiciyuan(...args)
}))

vi.mock('../autopixel/scraper', () => ({
  scrapeAutopixel: (...args: unknown[]) => scrapeAutopixel(...args)
}))

function baseIdentity(partial: Partial<ShopIdentity> = {}): ShopIdentity {
  return {
    family: 'unknown',
    platformId: null,
    token: null,
    scrapeStrategy: 'none',
    scrapable: false,
    profileEnabled: false,
    confidence: 'low',
    source: 'none',
    label: '未知',
    reason: '无法识别',
    ...partial
  }
}

describe('unknown-platform trial helpers', () => {
  beforeEach(() => {
    scrapeShopApi.mockReset()
    scrapeDujiao.mockReset()
    scrapeYiciyuan.mockReset()
    scrapeAutopixel.mockReset()
    scrapeShopApi.mockRejectedValue(new AppError('NOT_FOUND', 'shopapi miss'))
    scrapeDujiao.mockRejectedValue(new AppError('NOT_FOUND', 'dujiao miss'))
    scrapeYiciyuan.mockRejectedValue(new AppError('NOT_FOUND', 'yiciyuan miss'))
    scrapeAutopixel.mockRejectedValue(new AppError('NOT_FOUND', 'autopixel miss'))
  })

  it('shopApiTokenCandidate prefers /shop/:token path over hostname token', () => {
    const target: ShopScrapeTarget = {
      platformId: 'unknown',
      token: 'shop.example.com',
      merchantId: null
    }
    expect(shopApiTokenCandidate(target, 'https://shop.example.com/shop/ABC123', null)).toBe(
      'ABC123'
    )
    expect(shopApiTokenCandidate(target, null, null)).toBeNull()
    expect(
      shopApiTokenCandidate(
        { platformId: 'unknown', token: 'PAXOVOVJ', merchantId: null },
        null,
        null
      )
    ).toBe('PAXOVOVJ')
  })

  it('trialHostOf reads baseUrl or hostname-like token', () => {
    expect(
      trialHostOf({
        platformId: 'unknown',
        token: 'shop.example.com',
        merchantId: null
      })
    ).toBe('shop.example.com')
    expect(
      trialHostOf({
        platformId: 'unknown',
        token: 'tok',
        merchantId: null,
        baseUrl: 'https://host.example.com/path'
      })
    ).toBe('host.example.com')
  })

  it('shouldTrialUnknownPlatform skips known scrapable and shopapi profiles', () => {
    expect(
      shouldTrialUnknownPlatform(
        baseIdentity({
          family: 'shopapi',
          platformId: 'ldxp',
          token: 'ABC',
          scrapeStrategy: 'shopapi',
          scrapable: true,
          profileEnabled: true
        })
      )
    ).toBe(false)
    expect(
      shouldTrialUnknownPlatform(
        baseIdentity({
          family: 'shopapi',
          platformId: 'ldxp',
          token: 'ABC',
          scrapeStrategy: 'shopapi',
          scrapable: false,
          profileEnabled: false
        })
      )
    ).toBe(false)
    expect(
      shouldTrialUnknownPlatform(
        baseIdentity({
          family: 'yiciyuan',
          platformId: 'yiciyuan',
          token: 'kami.example.com',
          scrapeStrategy: 'yiciyuan',
          scrapable: false,
          profileEnabled: true
        })
      )
    ).toBe(true)
    expect(shouldTrialUnknownPlatform(baseIdentity())).toBe(true)
  })

  it('canBuildUnknownTrialTarget needs host or shop token material', () => {
    expect(canBuildUnknownTrialTarget({ host: 'a.example.com' })).toBe(true)
    expect(
      canBuildUnknownTrialTarget({ shopUrl: 'https://x.example.com/shop/TOK1' })
    ).toBe(true)
    expect(canBuildUnknownTrialTarget({ token: 'ONLYTOKEN' })).toBe(true)
    expect(canBuildUnknownTrialTarget({})).toBe(false)
  })

  it('all trial modes failing throws silentUnknown AppError', async () => {
    scrapeShopApi.mockRejectedValue(new AppError('NOT_FOUND', 'shopapi miss'))
    scrapeDujiao.mockRejectedValue(new AppError('NOT_FOUND', 'dujiao miss'))
    scrapeYiciyuan.mockRejectedValue(new AppError('NOT_FOUND', 'yiciyuan miss'))
    const target: ShopScrapeTarget = {
      platformId: 'unknown',
      token: 'mystery.example.com',
      merchantId: 'm1',
      baseUrl: 'https://mystery.example.com',
      trialUnknownPlatform: true
    }
    try {
      await scrapeUnknownPlatformTrials({ target, minIntervalMs: 1 })
      expect.unreachable('should throw')
    } catch (err) {
      expect(isSilentUnknownFailure(err)).toBe(true)
      expect(err).toBeInstanceOf(AppError)
      expect((err as AppError).code).toBe('NOT_FOUND')
    }
  })

  it('first mode with non-empty rows returns discoveredRef and stops', async () => {
    scrapeShopApi.mockRejectedValue(new AppError('NOT_FOUND', 'shopapi miss'))
    scrapeDujiao.mockResolvedValue({
      rows: [
        {
          id: 'dujiao:hit.example.com:1',
          source: 'dujiao',
          merchant_id: 'm1',
          source_shop_token: 'hit.example.com',
          source_goods_key: '1',
          source_url: null,
          shop_name: '试店',
          title: '商品A',
          price: 1,
          market_price: null,
          currency: 'CNY',
          goods_type: 'card',
          category_id: null,
          category_name: null,
          stock: 1,
          image: null,
          description_text: null,
          description_html: null,
          fetched_at: '2026-01-01T00:00:00.000Z',
          raw_json: '{}'
        }
      ],
      shopName: '试店',
      goodsCount: 1
    })
    scrapeYiciyuan.mockRejectedValue(new AppError('NOT_FOUND', 'should not run'))
    const target: ShopScrapeTarget = {
      platformId: 'unknown',
      token: 'hit.example.com',
      merchantId: 'm1',
      baseUrl: 'https://hit.example.com',
      trialUnknownPlatform: true
    }
    const result = await scrapeUnknownPlatformTrials({ target, minIntervalMs: 1 })
    expect(result.discoveredRef).toEqual({ platformId: 'dujiao', token: 'hit.example.com' })
    expect(result.shopName).toBe('试店')
    expect(result.rows).toHaveLength(1)
    expect(scrapeYiciyuan).not.toHaveBeenCalled()
  })

  it('empty catalog is not a trial match and continues to next mode', async () => {
    scrapeDujiao.mockResolvedValue({
      rows: [],
      shopName: '空店',
      goodsCount: 0
    })
    scrapeYiciyuan.mockResolvedValue({
      rows: [
        {
          id: 'yiciyuan:hit.example.com:9',
          source: 'yiciyuan',
          merchant_id: 'm1',
          source_shop_token: 'hit.example.com',
          source_goods_key: '9',
          source_url: null,
          shop_name: null,
          title: '商品B',
          price: 2,
          market_price: null,
          currency: 'CNY',
          goods_type: 'card',
          category_id: null,
          category_name: null,
          stock: 3,
          image: null,
          description_text: null,
          description_html: null,
          fetched_at: '2026-01-01T00:00:00.000Z',
          raw_json: '{}'
        }
      ],
      shopName: null,
      goodsCount: 1
    })
    const target: ShopScrapeTarget = {
      platformId: 'unknown',
      token: 'hit.example.com',
      merchantId: 'm1',
      baseUrl: 'https://hit.example.com',
      trialUnknownPlatform: true
    }
    const result = await scrapeUnknownPlatformTrials({ target, minIntervalMs: 1 })
    expect(result.discoveredRef).toEqual({ platformId: 'yiciyuan', token: 'hit.example.com' })
    expect(result.rows).toHaveLength(1)
    expect(scrapeDujiao).toHaveBeenCalled()
    expect(scrapeYiciyuan).toHaveBeenCalled()
  })

  it('autopixel mode matches path shop with products', async () => {
    scrapeDujiao.mockRejectedValue(new AppError('NOT_FOUND', 'dujiao miss'))
    scrapeYiciyuan.mockRejectedValue(new AppError('NOT_FOUND', 'yiciyuan miss'))
    scrapeAutopixel.mockResolvedValue({
      rows: [
        {
          id: 'autopixel:autopixel.qzz.io/blackcat:38',
          source: 'autopixel',
          merchant_id: null,
          source_shop_token: 'autopixel.qzz.io/blackcat',
          source_goods_key: '38',
          source_url: 'https://autopixel.qzz.io/blackcat',
          shop_name: null,
          title: 'Gemini',
          price: 168,
          market_price: 240,
          currency: 'CNY',
          goods_type: 'static',
          category_id: null,
          category_name: 'Gemini',
          stock: 0,
          image: null,
          description_text: null,
          description_html: null,
          fetched_at: '2026-01-01T00:00:00.000Z',
          raw_json: '{}'
        }
      ],
      shopName: null,
      goodsCount: 1,
      discoveredToken: 'autopixel.qzz.io/blackcat'
    })
    const target: ShopScrapeTarget = {
      platformId: 'unknown',
      token: 'autopixel.qzz.io',
      merchantId: null,
      baseUrl: 'https://autopixel.qzz.io',
      shopUrl: 'https://autopixel.qzz.io/blackcat',
      trialUnknownPlatform: true
    }
    const result = await scrapeUnknownPlatformTrials({
      target,
      minIntervalMs: 1,
      shopUrl: 'https://autopixel.qzz.io/blackcat'
    })
    expect(result.discoveredRef).toEqual({
      platformId: 'autopixel',
      token: 'autopixel.qzz.io/blackcat'
    })
    expect(result.rows).toHaveLength(1)
    expect(scrapeAutopixel).toHaveBeenCalled()
  })
})
