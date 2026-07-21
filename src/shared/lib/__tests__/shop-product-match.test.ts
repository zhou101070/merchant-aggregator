import { describe, expect, it } from 'vitest'
import type { ShopProduct } from '../../types/product'
import { filterAndRankShopProducts, shopProductMatchesQuery } from '../shop-product-match'

function p(partial: Partial<ShopProduct> & { id: string; title: string }): ShopProduct {
  return {
    source: 'ldxp',
    merchantId: 'm1',
    sourceShopToken: 'tk',
    sourceGoodsKey: partial.id,
    sourceUrl: null,
    shopName: null,
    price: 10,
    marketPrice: null,
    currency: 'CNY',
    goodsType: null,
    categoryId: null,
    categoryName: null,
    stock: 5,
    image: null,
    descriptionText: null,
    fetchedAt: new Date().toISOString(),
    ...partial
  }
}

describe('shopProductMatchesQuery', () => {
  it('matches synonym groups (gpt ↔ chatgpt)', () => {
    const row = p({ id: '1', title: 'ChatGPT Plus 月卡' })
    expect(shopProductMatchesQuery(row, 'gpt plus')).toBe(true)
    expect(shopProductMatchesQuery(row, 'claude')).toBe(false)
  })

  it('requires multi-token AND', () => {
    const row = p({ id: '1', title: 'Claude Pro 成品号' })
    expect(shopProductMatchesQuery(row, 'claude pro')).toBe(true)
    expect(shopProductMatchesQuery(row, 'claude team')).toBe(false)
  })

  it('Latin word whole-title match (team ≠ steam; category team ignored)', () => {
    expect(shopProductMatchesQuery(p({ id: '1', title: 'ChatGPT Team 月卡' }), 'team')).toBe(true)
    expect(shopProductMatchesQuery(p({ id: '2', title: 'ChatGPT 团队版' }), 'team')).toBe(true)
    expect(shopProductMatchesQuery(p({ id: '3', title: 'Steam 成品号' }), 'team')).toBe(false)
    expect(
      shopProductMatchesQuery(
        p({ id: '4', title: 'Codex 接码 美区', categoryName: 'GPT 反代用（team、k12）' }),
        'team'
      )
    ).toBe(false)
  })

  it('empty query matches all', () => {
    expect(shopProductMatchesQuery(p({ id: '1', title: 'x' }), '  ')).toBe(true)
  })
})

describe('filterAndRankShopProducts', () => {
  it('ranks full title phrase above partial title hit; drops category-only Latin', () => {
    const rows = [
      p({
        id: 'weak-cat',
        title: 'Pro 成品号',
        categoryName: 'Claude 区',
        price: 1,
        stock: 5
      }),
      p({
        id: 'weak-title',
        title: 'Claude 成品号 Pro 备用',
        categoryName: '其它',
        price: 1,
        stock: 5
      }),
      p({ id: 'strong', title: 'Claude Pro 月卡', categoryName: '其它', price: 99, stock: 5 })
    ]
    const out = filterAndRankShopProducts(rows, 'claude pro')
    // Latin words require title whole-word — category-only "Claude 区" is out
    expect(out.map((r) => r.id)).toEqual(['strong', 'weak-title'])
    expect(out.map((r) => r.id)).not.toContain('weak-cat')
  })
})
