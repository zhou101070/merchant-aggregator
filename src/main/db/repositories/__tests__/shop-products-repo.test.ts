import { describe, expect, it } from 'vitest'
import { openDatabase, closeDatabase } from '../../connection'
import { ShopProductsRepo, type NormalizedShopProductRow } from '../shop-products-repo'

function row(
  partial: Partial<NormalizedShopProductRow> & Pick<NormalizedShopProductRow, 'source_goods_key' | 'stock'>
): NormalizedShopProductRow {
  const token = partial.source_shop_token ?? 'tk1'
  const source = partial.source ?? 'ldxp'
  const key = partial.source_goods_key
  return {
    id: partial.id ?? `${source}:${token}:${key}`,
    source,
    merchant_id: partial.merchant_id ?? 'm1',
    source_shop_token: token,
    source_goods_key: key,
    source_url: null,
    shop_name: '店',
    title: partial.title ?? key,
    price: partial.price ?? 10,
    market_price: null,
    currency: 'CNY',
    goods_type: 'card',
    category_id: null,
    category_name: null,
    stock: partial.stock,
    image: null,
    description_text: null,
    description_html: null,
    fetched_at: new Date().toISOString(),
    raw_json: '{}'
  }
}

describe('ShopProductsRepo stock policy', () => {
  it('upsertMany keeps stock <= 0 and null', () => {
    const { db } = openDatabase({ filePath: ':memory:' })
    try {
      const repo = new ShopProductsRepo(db)
      const n = repo.upsertMany([
        row({ source_goods_key: 'a', stock: 5 }),
        row({ source_goods_key: 'b', stock: 0 }),
        row({ source_goods_key: 'c', stock: null }),
        row({ source_goods_key: 'd', stock: -1 })
      ])
      expect(n).toBe(4)
      expect(repo.count()).toBe(4)
      expect(repo.getById('ldxp:tk1:a')?.stock).toBe(5)
      expect(repo.getById('ldxp:tk1:b')?.stock).toBe(0)
      expect(repo.getById('ldxp:tk1:c')?.stock).toBeNull()
      expect(repo.getById('ldxp:tk1:d')?.stock).toBe(-1)
    } finally {
      closeDatabase(db)
    }
  })

  it('upsertMany writes title_norm and title_tokens from title', () => {
    const { db } = openDatabase({ filePath: ':memory:' })
    try {
      const repo = new ShopProductsRepo(db)
      repo.upsertMany([
        row({ source_goods_key: 'a', stock: 2, title: 'Claude Pro 月卡' })
      ])
      const stored = db
        .prepare(`SELECT title_norm, title_tokens FROM shop_products WHERE id = ?`)
        .get('ldxp:tk1:a') as { title_norm: string; title_tokens: string }
      expect(stored.title_norm).toBe('claude pro 月卡')
      expect(stored.title_tokens).toBe('claude pro 月卡')
    } finally {
      closeDatabase(db)
    }
  })

  it('replaceForShop deletes previous shop rows then inserts all including OOS', () => {
    const { db } = openDatabase({ filePath: ':memory:' })
    try {
      const repo = new ShopProductsRepo(db)
      repo.upsertMany([
        row({ source_goods_key: 'old1', stock: 3 }),
        row({ source_goods_key: 'old2', stock: 2 })
      ])
      expect(repo.count()).toBe(2)

      const r = repo.replaceForShop('ldxp', 'tk1', [
        row({ source_goods_key: 'new1', stock: 9 }),
        row({ source_goods_key: 'gone', stock: 0 }),
        row({ source_goods_key: 'old1', stock: 1 })
      ])
      expect(r.deleted).toBe(2)
      expect(r.inserted).toBe(3)
      expect(repo.count()).toBe(3)
      expect(repo.getById('ldxp:tk1:old2')).toBeNull()
      expect(repo.getById('ldxp:tk1:gone')?.stock).toBe(0)
      expect(repo.getById('ldxp:tk1:new1')?.stock).toBe(9)
      expect(repo.getById('ldxp:tk1:old1')?.stock).toBe(1)
    } finally {
      closeDatabase(db)
    }
  })

  it('replaceForShop with empty rows clears the shop', () => {
    const { db } = openDatabase({ filePath: ':memory:' })
    try {
      const repo = new ShopProductsRepo(db)
      repo.upsertMany([row({ source_goods_key: 'x', stock: 1 })])
      const r = repo.replaceForShop('ldxp', 'tk1', [])
      expect(r.deleted).toBe(1)
      expect(r.inserted).toBe(0)
      expect(repo.count()).toBe(0)
    } finally {
      closeDatabase(db)
    }
  })
})
