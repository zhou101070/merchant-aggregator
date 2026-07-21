import { describe, expect, it, vi } from 'vitest'
import type { NormalizedMerchantRow } from '../../priceai/normalize'
import {
  applyResolvedShopUrl,
  findShopApiItemUrl,
  hasParseableShopUrl,
  resolveMerchantItemLinks
} from '../resolve-item-shop'

function baseRow(partial: Partial<NormalizedMerchantRow> & Pick<NormalizedMerchantRow, 'id'>): NormalizedMerchantRow {
  return {
    name: partial.id,
    store_name: null,
    host: null,
    shop_url: null,
    entry_url: null,
    source_id: null,
    source_name: null,
    collector_kind: null,
    health_status: null,
    offer_count: 0,
    in_stock_count: 0,
    out_of_stock_count: 0,
    product_count: 0,
    platform_count: 0,
    platforms_json: '[]',
    product_types_json: '[]',
    representative_product: null,
    representative_offer_title: null,
    representative_price: null,
    representative_currency: null,
    lowest_hit_count: 0,
    warranty_lowest_hit_count: 0,
    risk_feedback_count: 0,
    has_platform_aftersales: 0,
    shop_created_at: null,
    included_at: null,
    last_success_at: null,
    latest_seen_at: null,
    consecutive_failures: 0,
    observation_started_at: null,
    generated_at: null,
    fetched_at: '2026-07-21T00:00:00.000Z',
    raw_json: '{}',
    ldxp_token: null,
    shop_platform: null,
    shop_token: null,
    name_norm: partial.id,
    _shopRefDerived: false,
    ...partial
  }
}

describe('findShopApiItemUrl / hasParseableShopUrl', () => {
  it('detects ldxp item URLs', () => {
    expect(findShopApiItemUrl(null, 'https://pay.ldxp.cn/item/5ozbbc')).toBe(
      'https://pay.ldxp.cn/item/5ozbbc'
    )
    expect(findShopApiItemUrl('https://catfk.com/item/ab_cd')).toBe('https://catfk.com/item/ab_cd')
  })

  it('ignores non-registered item hosts', () => {
    expect(findShopApiItemUrl('https://wiki123.top/item/8')).toBeNull()
  })

  it('detects shop home URLs', () => {
    expect(hasParseableShopUrl('https://pay.ldxp.cn/shop/PAXOVOVJ', null)).toBe(true)
    expect(hasParseableShopUrl(null, 'https://pay.ldxp.cn/item/5ozbbc')).toBe(false)
  })
})

describe('applyResolvedShopUrl', () => {
  it('writes shop root and derives ldxp ref', () => {
    const row = baseRow({
      id: 'm1',
      entry_url: 'https://pay.ldxp.cn/item/5ozbbc'
    })
    const out = applyResolvedShopUrl(row, {
      shopUrl: 'https://pay.ldxp.cn/shop/PAXOVOVJ',
      token: 'PAXOVOVJ',
      platformId: 'ldxp'
    })
    expect(out.shop_url).toBe('https://pay.ldxp.cn/shop/PAXOVOVJ')
    expect(out.entry_url).toBe('https://pay.ldxp.cn/shop/PAXOVOVJ')
    expect(out.shop_platform).toBe('ldxp')
    expect(out.shop_token).toBe('PAXOVOVJ')
    expect(out.ldxp_token).toBe('PAXOVOVJ')
    expect(out.host).toBe('pay.ldxp.cn')
    expect(out._shopRefDerived).toBe(true)
  })
})

describe('resolveMerchantItemLinks', () => {
  it('keeps rows that already have a shop home URL without calling resolver', async () => {
    const resolveItem = vi.fn(async () => null)
    const row = baseRow({
      id: 'ok',
      shop_url: 'https://pay.ldxp.cn/shop/TOK1',
      entry_url: 'https://pay.ldxp.cn/shop/TOK1',
      shop_platform: 'ldxp',
      shop_token: 'TOK1',
      _shopRefDerived: true
    })
    const result = await resolveMerchantItemLinks([row], { resolveItem })
    expect(result.rows).toHaveLength(1)
    expect(result.resolvedFromItem).toBe(0)
    expect(result.droppedItemUnresolved).toBe(0)
    expect(resolveItem).not.toHaveBeenCalled()
  })

  it('resolves item-only entry and rewrites shop ref', async () => {
    const resolveItem = vi.fn(async () => ({
      shopUrl: 'https://pay.ldxp.cn/shop/PAXOVOVJ',
      token: 'PAXOVOVJ',
      platformId: 'ldxp'
    }))
    const row = baseRow({
      id: 'item-only',
      entry_url: 'https://pay.ldxp.cn/item/5ozbbc'
    })
    const result = await resolveMerchantItemLinks([row], { resolveItem })
    expect(resolveItem).toHaveBeenCalledWith('https://pay.ldxp.cn/item/5ozbbc', undefined)
    expect(result.rows).toHaveLength(1)
    expect(result.resolvedFromItem).toBe(1)
    expect(result.rows[0]!.shop_token).toBe('PAXOVOVJ')
    expect(result.rows[0]!.shop_url).toBe('https://pay.ldxp.cn/shop/PAXOVOVJ')
  })

  it('drops item-only rows when resolve fails', async () => {
    const resolveItem = vi.fn(async () => null)
    const row = baseRow({
      id: 'dead-item',
      entry_url: 'https://pay.ldxp.cn/item/nope'
    })
    const result = await resolveMerchantItemLinks([row], { resolveItem })
    expect(result.rows).toHaveLength(0)
    expect(result.droppedItemUnresolved).toBe(1)
  })

  it('keeps non-shopApi external entry without resolve', async () => {
    const resolveItem = vi.fn(async () => null)
    const row = baseRow({
      id: 'generic',
      entry_url: 'https://example-shop.test/p/99'
    })
    const result = await resolveMerchantItemLinks([row], { resolveItem })
    expect(result.rows).toHaveLength(1)
    expect(result.rows[0]!.entry_url).toBe('https://example-shop.test/p/99')
    expect(resolveItem).not.toHaveBeenCalled()
  })
})
