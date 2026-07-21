import { describe, expect, it } from 'vitest'
import {
  collapseMerchantBatch,
  merchantIdentityKeys,
  mergeNormalizedMerchantRows,
  normalizeMerchantLinkKey,
  preferMerchantId,
  shopRefIdentityKey
} from '../merchant-identity'

type Row = Parameters<typeof mergeNormalizedMerchantRows>[0]

function row(partial: Partial<Row> & Pick<Row, 'id' | 'name'>): Row {
  return {
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
    fetched_at: '2026-07-18T00:00:00.000Z',
    raw_json: '{}',
    ldxp_token: null,
    shop_platform: null,
    shop_token: null,
    name_norm: partial.name.toLowerCase(),
    _shopRefDerived: false,
    ...partial
  }
}

describe('normalizeMerchantLinkKey', () => {
  it('normalizes host case and trailing slash', () => {
    expect(normalizeMerchantLinkKey('https://Pay.Ldxp.CN/shop/ABC/')).toBe(
      'https://pay.ldxp.cn/shop/ABC'
    )
  })

  it('returns null for empty', () => {
    expect(normalizeMerchantLinkKey(null)).toBeNull()
    expect(normalizeMerchantLinkKey('  ')).toBeNull()
  })
})

describe('shopRefIdentityKey', () => {
  it('lowercases platform and token', () => {
    expect(shopRefIdentityKey('Ldxp', 'AbC')).toBe('ref:ldxp:abc')
  })
})

describe('preferMerchantId', () => {
  it('prefers non-nodebits id', () => {
    expect(preferMerchantId('nodebits-x', 'merchant-1')).toBe('merchant-1')
    expect(preferMerchantId('merchant-1', 'nodebits-x')).toBe('merchant-1')
  })
})

describe('merchantIdentityKeys', () => {
  it('emits ref and url keys', () => {
    const keys = merchantIdentityKeys({
      shop_platform: 'ldxp',
      shop_token: 'TOK1',
      shop_url: 'https://pay.ldxp.cn/shop/TOK1',
      entry_url: 'https://pay.ldxp.cn/shop/TOK1/item/1'
    })
    expect(keys).toContain('ref:ldxp:tok1')
    expect(keys.some((k) => k.startsWith('url:'))).toBe(true)
  })
})

describe('collapseMerchantBatch', () => {
  it('merges priceai + nodebits with same shop ref', () => {
    const a = row({
      id: 'priceai-1',
      name: '店A',
      shop_platform: 'ldxp',
      shop_token: 'TOK1',
      shop_url: 'https://pay.ldxp.cn/shop/TOK1',
      offer_count: 10,
      _shopRefDerived: true,
      source_name: 'PriceAI'
    })
    const b = row({
      id: 'nodebits-uuid',
      name: '店A-nb',
      shop_platform: 'ldxp',
      shop_token: 'tok1',
      shop_url: 'https://pay.ldxp.cn/shop/TOK1/',
      offer_count: 3,
      _shopRefDerived: true,
      source_name: 'NodeBits'
    })
    const out = collapseMerchantBatch([a, b])
    expect(out).toHaveLength(1)
    expect(out[0]!.id).toBe('priceai-1')
    expect(out[0]!.offer_count).toBe(10)
    expect(out[0]!.source_name).toContain('PriceAI')
    expect(out[0]!.source_name).toContain('NodeBits')
  })

  it('merges by identical entry_url when no shop ref', () => {
    const a = row({
      id: 'a',
      name: 'X',
      entry_url: 'https://example.com/shop/1'
    })
    const b = row({
      id: 'b',
      name: 'Y',
      entry_url: 'https://Example.com/shop/1/'
    })
    const out = collapseMerchantBatch([a, b])
    expect(out).toHaveLength(1)
    expect(['a', 'b']).toContain(out[0]!.id)
  })
})

describe('mergeNormalizedMerchantRows', () => {
  it('keeps winner id and max offer_count', () => {
    const a = row({ id: 'keep', name: 'A', offer_count: 1, shop_url: null })
    const b = row({
      id: 'drop',
      name: 'B',
      offer_count: 9,
      shop_url: 'https://pay.ldxp.cn/shop/Z'
    })
    const m = mergeNormalizedMerchantRows(a, b, 'keep')
    expect(m.id).toBe('keep')
    expect(m.offer_count).toBe(9)
    expect(m.shop_url).toBe('https://pay.ldxp.cn/shop/Z')
  })
})
