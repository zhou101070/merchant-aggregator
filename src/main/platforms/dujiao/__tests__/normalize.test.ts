import { describe, expect, it } from 'vitest'
import type { DujiaoProduct } from '../client'
import {
  normalizeDujiaoProduct,
  normalizeDujiaoProducts,
  parseDujiaoGoodsKey,
  pickI18n,
  productStock
} from '../normalize'

const baseOpts = {
  host: 'flyai.qzz.io',
  baseUrl: 'https://flyai.qzz.io',
  merchantId: 'm1',
  shopName: 'AI开发商',
  currency: 'CNY',
  fetchedAt: '2026-07-18T00:00:00.000Z'
}

function product(partial: Partial<DujiaoProduct> & Pick<DujiaoProduct, 'slug'>): DujiaoProduct {
  return {
    id: 1,
    title: { 'zh-CN': '测试商品' },
    price_amount: '10.00',
    auto_stock_available: 0,
    manual_stock_available: 0,
    is_sold_out: false,
    skus: [],
    ...partial
  }
}

describe('pickI18n', () => {
  it('prefers zh-CN', () => {
    expect(pickI18n({ 'zh-CN': '中', 'en-US': 'en' })).toBe('中')
    expect(pickI18n({ 'en-US': 'en' })).toBe('en')
  })
})

describe('productStock', () => {
  it('uses product-level available first', () => {
    expect(
      productStock(
        product({
          slug: 'a',
          auto_stock_available: 3,
          manual_stock_available: 2,
          skus: [{ id: 1, auto_stock_available: 99, is_active: true }]
        })
      )
    ).toBe(5)
  })

  it('falls back to sku sum', () => {
    expect(
      productStock(
        product({
          slug: 'a',
          auto_stock_available: 0,
          skus: [
            { id: 1, auto_stock_available: 7, is_active: true },
            { id: 2, manual_stock_total: 5, manual_stock_sold: 2, is_active: true },
            { id: 3, auto_stock_available: 9, is_active: false }
          ]
        })
      )
    ).toBe(10)
  })
})

describe('normalizeDujiaoProduct', () => {
  it('emits product-level row for single sku', () => {
    const rows = normalizeDujiaoProduct(
      product({
        slug: 'gpt-plus',
        title: { 'zh-CN': 'GPT Plus' },
        price_amount: '12.5',
        auto_stock_available: 4,
        category_id: 8,
        category: { id: 8, name: { 'zh-CN': 'GPT' } },
        images: ['/uploads/a.png'],
        content: { 'zh-CN': '<p>详情</p>' },
        skus: [{ id: 1, sku_code: 'default', auto_stock_available: 4, is_active: true }]
      }),
      baseOpts
    )
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      id: 'dujiao:flyai.qzz.io:gpt-plus',
      source: 'dujiao',
      source_shop_token: 'flyai.qzz.io',
      source_goods_key: 'gpt-plus',
      source_url: 'https://flyai.qzz.io/products/gpt-plus',
      title: 'GPT Plus',
      price: 12.5,
      stock: 4,
      category_name: 'GPT',
      image: 'https://flyai.qzz.io/uploads/a.png',
      description_text: '详情'
    })
  })

  it('expands multi-sku with different prices', () => {
    const rows = normalizeDujiaoProduct(
      product({
        slug: 'gptplus',
        title: { 'zh-CN': 'Plus 成品' },
        price_amount: '10.00',
        auto_stock_available: 7,
        skus: [
          {
            id: 11,
            sku_code: 'ms',
            spec_values: { 'zh-CN': '微软邮箱' },
            price_amount: '10.00',
            auto_stock_available: 7,
            is_active: true
          },
          {
            id: 7,
            sku_code: 'icloud',
            spec_values: { 'zh-CN': 'icloud' },
            price_amount: '18.00',
            auto_stock_available: 0,
            is_active: true
          },
          {
            id: 99,
            price_amount: '1.00',
            auto_stock_available: 5,
            is_active: false
          }
        ]
      }),
      baseOpts
    )
    expect(rows).toHaveLength(1)
    expect(rows[0].source_goods_key).toBe('gptplus#11')
    expect(rows[0].title).toBe('Plus 成品 · 微软邮箱')
    expect(rows[0].price).toBe(10)
    expect(rows[0].stock).toBe(7)
  })

  it('skips sold out / zero stock', () => {
    expect(
      normalizeDujiaoProduct(
        product({
          slug: 'oos',
          is_sold_out: true,
          auto_stock_available: 0,
          skus: [{ id: 1, auto_stock_available: 0, is_active: true }]
        }),
        baseOpts
      )
    ).toEqual([])
  })

  it('onlyGoodsKey filters sku row', () => {
    const p = product({
      slug: 'multi',
      auto_stock_available: 5,
      skus: [
        { id: 1, price_amount: '1', auto_stock_available: 2, is_active: true },
        { id: 2, price_amount: '2', auto_stock_available: 3, is_active: true }
      ]
    })
    const rows = normalizeDujiaoProduct(p, { ...baseOpts, onlyGoodsKey: 'multi#2' })
    expect(rows).toHaveLength(1)
    expect(rows[0].source_goods_key).toBe('multi#2')
    expect(rows[0].stock).toBe(3)
  })
})

describe('normalizeDujiaoProducts', () => {
  it('flattens list', () => {
    const rows = normalizeDujiaoProducts(
      [
        product({ slug: 'a', auto_stock_available: 1 }),
        product({ slug: 'b', auto_stock_available: 0, is_sold_out: true })
      ],
      baseOpts
    )
    expect(rows.map((r) => r.source_goods_key)).toEqual(['a'])
  })
})

describe('parseDujiaoGoodsKey', () => {
  it('splits slug and sku', () => {
    expect(parseDujiaoGoodsKey('gpt#11')).toEqual({ slug: 'gpt', skuId: '11' })
    expect(parseDujiaoGoodsKey('gpt')).toEqual({ slug: 'gpt', skuId: null })
  })
})
