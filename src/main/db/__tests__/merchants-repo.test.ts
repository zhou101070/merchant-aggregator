import { describe, expect, it } from 'vitest'
import { openDatabase, closeDatabase } from '../connection'
import { MerchantsRepo } from '../repositories/merchants-repo'
import { FavoritesRepo } from '../repositories/favorites-repo'

function insertMerchant(
  db: ReturnType<typeof openDatabase>['db'],
  row: {
    id: string
    name: string
    host?: string | null
    collectorKind?: string | null
    ldxpToken?: string | null
    shopPlatform?: string | null
    shopToken?: string | null
    offerCount?: number
    appHealthStatus?: string | null
    appHealthAt?: string | null
    platformsJson?: string
    representativeProduct?: string | null
  }
): void {
  const token = row.shopToken ?? row.ldxpToken ?? null
  const platform =
    row.shopPlatform !== undefined ? row.shopPlatform : token ? 'ldxp' : null
  db.prepare(
    `INSERT INTO merchants (
       id, name, host, collector_kind, fetched_at, ldxp_token, shop_platform, shop_token, offer_count,
       app_health_status, app_health_at, platforms_json, representative_product
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    row.id,
    row.name,
    row.host ?? null,
    row.collectorKind ?? null,
    new Date().toISOString(),
    platform === 'ldxp' ? token : (row.ldxpToken ?? null),
    platform,
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
  it('listScrapableNeedingSync skips fresh-healthy shops, keeps stale/failed/never', () => {
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

      const targets = repo.listScrapableNeedingSync({ freshHours: 24 })
      expect(targets.map((t) => t.id)).toEqual(['never', 'stale', 'failed']) // offer_count desc
      expect(targets.map((t) => t.id)).not.toContain('fresh')
      expect(targets.map((t) => t.id)).not.toContain('nonldxp')

      const top1 = repo.listScrapableNeedingSync({ freshHours: 24, limit: 1 })
      expect(top1.map((t) => t.id)).toEqual(['never'])

      expect(repo.listScrapableMerchants().length).toBe(4)
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

describe('MerchantsRepo list health filters', () => {
  it('excludes non-scrapable rows from healthy/failing/retrying filters', () => {
    const { db } = openDatabase({ filePath: ':memory:' })
    try {
      const repo = new MerchantsRepo(db)
      insertMerchant(db, {
        id: 'scrapable-fail',
        name: '可刮失败',
        shopPlatform: 'ldxp',
        shopToken: 'tok',
        appHealthStatus: 'failing',
        appHealthAt: hoursAgo(1)
      })
      // Non-scrapable but residual failing status in DB
      insertMerchant(db, {
        id: 'orphan-fail',
        name: '不可刮残留',
        appHealthStatus: 'failing',
        appHealthAt: hoursAgo(1)
      })

      const failing = repo.list({ health: ['failing'], offset: 0, limit: 50 })
      expect(failing.rows.map((r) => r.id)).toEqual(['scrapable-fail'])
      expect(failing.rows[0]?.healthStatus).toBe('failing')

      const na = repo.list({ health: ['n/a'], offset: 0, limit: 50 })
      expect(na.rows.map((r) => r.id)).toEqual(['orphan-fail'])
      expect(na.rows[0]?.healthStatus).toBe('n/a')
    } finally {
      closeDatabase(db)
    }
  })
})

describe('MerchantsRepo list shopPlatforms', () => {
  it('filters by shop_platform', () => {
    const { db } = openDatabase({ filePath: ':memory:' })
    try {
      const repo = new MerchantsRepo(db)
      insertMerchant(db, { id: 'l1', name: '链动店', shopPlatform: 'ldxp', shopToken: 'a' })
      insertMerchant(db, { id: 'c1', name: 'catfk店', shopPlatform: 'catfk', shopToken: 'b' })
      insertMerchant(db, { id: 'n1', name: '无平台店' })

      const all = repo.list({ offset: 0, limit: 50 })
      expect(all.total).toBe(3)

      const ldxp = repo.list({ shopPlatforms: ['ldxp'], offset: 0, limit: 50 })
      expect(ldxp.rows.map((r) => r.id)).toEqual(['l1'])

      const catfk = repo.list({ shopPlatforms: ['catfk'], offset: 0, limit: 50 })
      expect(catfk.rows.map((r) => r.id)).toEqual(['c1'])

      insertMerchant(db, {
        id: 'd1',
        name: '独角店-仅collector',
        host: 'flyai.qzz.io',
        collectorKind: 'dujiao'
      })
      insertMerchant(db, {
        id: 'd2',
        name: '独角店-已回填',
        host: 'morimm.com',
        shopPlatform: 'dujiao',
        shopToken: 'morimm.com',
        collectorKind: 'dujiao'
      })
      const dujiao = repo.list({ shopPlatforms: ['dujiao'], offset: 0, limit: 50 })
      expect(dujiao.rows.map((r) => r.id).sort()).toEqual(['d1', 'd2'])

      insertMerchant(db, {
        id: 'y1',
        name: '异次元-仅collector',
        host: 'web3chirou.com',
        collectorKind: 'kami'
      })
      insertMerchant(db, {
        id: 'y2',
        name: '异次元-已回填',
        host: 'ai666.id',
        shopPlatform: 'yiciyuan',
        shopToken: 'ai666.id',
        collectorKind: 'kami'
      })
      const yiciyuan = repo.list({ shopPlatforms: ['yiciyuan'], offset: 0, limit: 50 })
      expect(yiciyuan.rows.map((r) => r.id).sort()).toEqual(['y1', 'y2'])

      const both = repo.list({ shopPlatforms: ['ldxp', 'catfk'], offset: 0, limit: 50 })
      expect(both.rows.map((r) => r.id).sort()).toEqual(['c1', 'l1'])

      insertMerchant(db, { id: 'x1', name: '未知平台店', shopPlatform: 'weird', shopToken: 'z' })
      insertMerchant(db, {
        id: 'legacy',
        name: '仅 ldxp_token',
        ldxpToken: 'legacyTok'
      })
      const other = repo.list({ shopPlatforms: ['other'], offset: 0, limit: 50 })
      // n1 null platform; x1 unknown platform; legacy dual-fills as ldxp → not other
      expect(other.rows.map((r) => r.id).sort()).toEqual(['n1', 'x1'])

      const otherScrapable = repo.list({
        shopPlatforms: ['other'],
        scrapableOnly: true,
        offset: 0,
        limit: 50
      })
      // weird has token+platform → scrapable unknown platform still counts as other
      expect(otherScrapable.rows.map((r) => r.id)).toEqual(['x1'])
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
      expect(product.baselinePrice).toBe(12.5)
      expect(product.stock).toBe(3)
      expect(product.ldxpToken).toBe('tk1')
      expect(product.merchantId).toBe('m1')
      expect(product.sourceUrl).toContain('/item/g1')

      favs.update({
        targetType: 'shop_product',
        targetId: 'ldxp:tk1:g1',
        note: '待买',
        targetPrice: 10
      })
      const updated = favs.list().find((f) => f.targetType === 'shop_product')!
      expect(updated.note).toBe('待买')
      expect(updated.targetPrice).toBe(10)
      expect(updated.baselinePrice).toBe(12.5)

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
