import { describe, expect, it } from 'vitest'
import type { YiciyuanCommodity } from '../client'
import {
  commodityPrice,
  commodityStock,
  isYiciyuanCommodityListed,
  normalizeYiciyuanCommodity,
  normalizeYiciyuanCommodities
} from '../normalize'

const baseOpts = {
  host: 'web3chirou.com',
  baseUrl: 'https://web3chirou.com',
  merchantId: 'm1',
  shopName: '蔚莱云',
  currency: 'CNY',
  fetchedAt: '2026-07-18T00:00:00.000Z'
}

function item(
  partial: Partial<YiciyuanCommodity> & Pick<YiciyuanCommodity, 'id' | 'name'>
): YiciyuanCommodity {
  return {
    status: 1,
    hide: 0,
    price: 1.5,
    user_price: 1.5,
    stock: 10,
    category_id: 4,
    category: { id: 4, name: 'Discord' },
    cover: '/assets/a.png',
    delivery_way: 0,
    ...partial
  }
}

describe('commodity helpers', () => {
  it('reads stock and price', () => {
    expect(commodityStock(item({ id: 1, name: 'a', stock: 12 }))).toBe(12)
    expect(commodityPrice(item({ id: 1, name: 'a', user_price: 2.5, price: 9 }))).toBe(2.5)
    expect(commodityPrice(item({ id: 1, name: 'a', user_price: null, price: 3 }))).toBe(3)
  })

  it('filters hidden / inactive; OOS still listed', () => {
    expect(isYiciyuanCommodityListed(item({ id: 1, name: 'a', stock: 1 }))).toBe(true)
    expect(isYiciyuanCommodityListed(item({ id: 1, name: 'a', status: 0, stock: 9 }))).toBe(false)
    expect(isYiciyuanCommodityListed(item({ id: 1, name: 'a', hide: 1, stock: 9 }))).toBe(false)
    expect(isYiciyuanCommodityListed(item({ id: 1, name: 'a', stock: 0 }))).toBe(true)
  })
})

describe('normalizeYiciyuanCommodity', () => {
  it('emits row with item page url', () => {
    const row = normalizeYiciyuanCommodity(
      item({
        id: 20,
        name: 'DC账号',
        stock: 1634,
        user_price: 1.5
      }),
      baseOpts
    )
    expect(row).toMatchObject({
      id: 'yiciyuan:web3chirou.com:20',
      source: 'yiciyuan',
      source_shop_token: 'web3chirou.com',
      source_goods_key: '20',
      source_url: 'https://web3chirou.com/item/20',
      title: 'DC账号',
      price: 1.5,
      stock: 1634,
      category_name: 'Discord',
      category_id: 4,
      image: 'https://web3chirou.com/assets/a.png',
      goods_type: 'delivery_0'
    })
  })

  it('onlyGoodsKey filters', () => {
    expect(
      normalizeYiciyuanCommodity(item({ id: 20, name: 'a' }), {
        ...baseOpts,
        onlyGoodsKey: '99'
      })
    ).toBeNull()
  })

  it('normalizes list including OOS; drops hidden', () => {
    const rows = normalizeYiciyuanCommodities(
      [
        item({ id: 1, name: 'ok', stock: 2 }),
        item({ id: 2, name: 'oos', stock: 0 }),
        item({ id: 3, name: 'hide', hide: 1, stock: 5 })
      ],
      baseOpts
    )
    expect(rows.map((r) => r.source_goods_key)).toEqual(['1', '2'])
    expect(rows.find((r) => r.source_goods_key === '2')?.stock).toBe(0)
  })
})
