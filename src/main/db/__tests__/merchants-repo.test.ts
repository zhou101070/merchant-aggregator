import { describe, expect, it } from 'vitest'
import { openDatabase, closeDatabase } from '../connection'
import { MerchantsRepo } from '../repositories/merchants-repo'
import { FavoritesRepo } from '../repositories/favorites-repo'

function insertMerchant(
  db: ReturnType<typeof openDatabase>['db'],
  row: {
    id: string
    name: string
    ldxpToken?: string | null
    offerCount?: number
    appHealthStatus?: string | null
    appHealthAt?: string | null
    platformsJson?: string
    representativeProduct?: string | null
  }
): void {
  const token = row.ldxpToken ?? null
  db.prepare(
    `INSERT INTO merchants (
       id, name, fetched_at, ldxp_token, shop_platform, shop_token, offer_count,
       app_health_status, app_health_at, platforms_json, representative_product
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    row.id,
    row.name,
    new Date().toISOString(),
    token,
    token ? 'ldxp' : null,
    token,
    row.offerCount ?? 0,
    row.appHealthStatus ?? null,
    row.appHealthAt ?? null,
    row.platformsJson ?? '[]',
    row.representativeProduct ?? null
  )
}

function hoursAgo(h: number): string {
  return new Date(Date.now() - h * 3_600_000).toISOString()
}

describe('MerchantsRepo incremental sync helpers', () => {
  it('listLdxpNeedingSync skips fresh-healthy shops, keeps stale/failed/never', () => {
    const { db } = openDatabase({ filePath: ':memory:' })
    try {
      const repo = new MerchantsRepo(db)
      insertMerchant(db, {
        id: 'fresh',
        name: '新鲜店',
        ldxpToken: 'tk1',
        offerCount: 100,
        appHealthStatus: 'healthy',
        appHealthAt: hoursAgo(1)
      })
      insertMerchant(db, {
        id: 'stale',
        name: '过期店',
        ldxpToken: 'tk2',
        offerCount: 50,
        appHealthStatus: 'healthy',
        appHealthAt: hoursAgo(48)
      })
      insertMerchant(db, { id: 'never', name: '未同步店', ldxpToken: 'tk3', offerCount: 80 })
      insertMerchant(db, {
        id: 'failed',
        name: '失败店',
        ldxpToken: 'tk4',
        offerCount: 10,
        appHealthStatus: 'failing',
        appHealthAt: hoursAgo(1)
      })
      insertMerchant(db, { id: 'nonldxp', name: '非ldxp', offerCount: 999 })

      const targets = repo.listLdxpNeedingSync({ freshHours: 24 })
      expect(targets.map((t) => t.id)).toEqual(['never', 'stale', 'failed']) // offer_count desc
      expect(targets.map((t) => t.id)).not.toContain('fresh')
      expect(targets.map((t) => t.id)).not.toContain('nonldxp')

      const top1 = repo.listLdxpNeedingSync({ freshHours: 24, limit: 1 })
      expect(top1.map((t) => t.id)).toEqual(['never'])

      // force 全量场景仍走 listLdxpMerchants
      expect(repo.listLdxpMerchants().length).toBe(4)
    } finally {
      closeDatabase(db)
    }
  })

  it('candidatesForQuery matches tokens over name/platforms/representative and excludes fresh', () => {
    const { db } = openDatabase({ filePath: ':memory:' })
    try {
      const repo = new MerchantsRepo(db)
      insertMerchant(db, {
        id: 'claudeFresh',
        name: 'AI 小铺',
        ldxpToken: 'tka',
        offerCount: 100,
        platformsJson: '["Claude","ChatGPT"]',
        appHealthStatus: 'healthy',
        appHealthAt: hoursAgo(1)
      })
      insertMerchant(db, {
        id: 'claudeStale',
        name: '号铺',
        ldxpToken: 'tkb',
        offerCount: 60,
        representativeProduct: 'Claude Pro 会员'
      })
      insertMerchant(db, {
        id: 'mailShop',
        name: 'Outlook 邮箱店',
        ldxpToken: 'tkc',
        offerCount: 5
      })

      const c = repo.candidatesForQuery('Claude Pro', 24)
      expect(c.totalMatching).toBe(2) // fresh + stale 都匹配关键词
      expect(c.merchantIds).toEqual(['claudeStale']) // 新鲜店不重复同步
      expect(c.sample).toEqual(['号铺'])

      const none = repo.candidatesForQuery('   ', 24)
      expect(none.merchantIds).toEqual([])
      expect(none.totalMatching).toBe(0)
    } finally {
      closeDatabase(db)
    }
  })
})

describe('FavoritesRepo enrichment', () => {
  it('returns current price/token for shop_product and merchant favorites', () => {
    const { db } = openDatabase({ filePath: ':memory:' })
    try {
      insertMerchant(db, { id: 'm1', name: '某店', ldxpToken: 'tk1' })
      db.prepare(
        `INSERT INTO shop_products (
           id, source, merchant_id, source_shop_token, source_goods_key,
           source_url, title, price, currency, stock, fetched_at
         ) VALUES (?, 'ldxp', 'm1', 'tk1', 'g1', ?, ?, 12.5, 'CNY', 3, ?)`
      ).run('ldxp:tk1:g1', 'https://pay.ldxp.cn/item/g1', 'Claude Pro 月卡', hoursAgo(2))

      const favs = new FavoritesRepo(db)
      favs.add({ targetType: 'shop_product', targetId: 'ldxp:tk1:g1' })
      favs.add({ targetType: 'merchant', targetId: 'm1' })

      const list = favs.list()
      const product = list.find((f) => f.targetType === 'shop_product')!
      expect(product.titleSnapshot).toBe('Claude Pro 月卡')
      expect(product.price).toBe(12.5)
      expect(product.stock).toBe(3)
      expect(product.ldxpToken).toBe('tk1')
      expect(product.merchantId).toBe('m1')
      expect(product.sourceUrl).toContain('/item/g1')

      const merchant = list.find((f) => f.targetType === 'merchant')!
      expect(merchant.titleSnapshot).toBe('某店')
      expect(merchant.ldxpToken).toBe('tk1')
      expect(merchant.merchantId).toBe('m1')
      expect(merchant.price).toBeNull()
    } finally {
      closeDatabase(db)
    }
  })
})
