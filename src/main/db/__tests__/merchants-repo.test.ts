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

      const targets = repo.listScrapableNeedingSync({ freshMinutes: 24 * 60 })
      expect(targets.map((t) => t.id)).toEqual(['never', 'stale', 'failed']) // offer_count desc
      expect(targets.map((t) => t.id)).not.toContain('fresh')
      expect(targets.map((t) => t.id)).not.toContain('nonldxp')

      const autoPool = repo.listScrapableNeedingSync({ freshMinutes: 24 * 60, excludeFailing: true })
      expect(autoPool.map((t) => t.id)).toEqual(['never', 'stale'])
      expect(autoPool.map((t) => t.id)).not.toContain('failed')

      const top1 = repo.listScrapableNeedingSync({ freshMinutes: 24 * 60, limit: 1 })
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

      const c = repo.candidatesForQuery('Claude Pro', 24 * 60)
      expect(c.totalMatching).toBe(2) // fresh + stale 都匹配关键词
      expect(c.merchantIds).toEqual(['claudeStale']) // 新鲜店不重复同步
      expect(c.sample).toEqual(['号铺'])

      const none = repo.candidatesForQuery('   ', 24 * 60)
      expect(none.merchantIds).toEqual([])
      expect(none.totalMatching).toBe(0)
    } finally {
      closeDatabase(db)
    }
  })
})

describe('MerchantsRepo setAppHealth timestamp', () => {
  it('refreshes app_health_at only on healthy; failing/retrying preserve stamp', () => {
    const { db } = openDatabase({ filePath: ':memory:' })
    try {
      const repo = new MerchantsRepo(db)
      const successAt = hoursAgo(5)
      insertMerchant(db, {
        id: 'm1',
        name: '店',
        shopPlatform: 'ldxp',
        shopToken: 'tok1',
        appHealthStatus: 'healthy',
        appHealthAt: successAt
      })

      repo.setAppHealth('m1', 'retrying')
      let row = repo.getById('m1')
      expect(row?.healthStatus).toBe('retrying')
      expect(row?.healthCheckedAt).toBe(successAt)

      repo.setAppHealth('m1', 'failing', 'network')
      row = repo.getById('m1')
      expect(row?.healthStatus).toBe('failing')
      expect(row?.healthMessage).toBe('network')
      expect(row?.healthCheckedAt).toBe(successAt)

      const beforeOk = Date.now()
      repo.setAppHealth('m1', 'healthy')
      row = repo.getById('m1')
      expect(row?.healthStatus).toBe('healthy')
      expect(row?.healthCheckedAt).toBeTruthy()
      expect(Date.parse(row!.healthCheckedAt!)).toBeGreaterThanOrEqual(beforeOk - 1000)
      expect(row?.healthCheckedAt).not.toBe(successAt)

      // by shop ref
      insertMerchant(db, {
        id: 'm2',
        name: '店2',
        shopPlatform: 'ldxp',
        shopToken: 'tok2',
        appHealthStatus: 'healthy',
        appHealthAt: successAt
      })
      repo.setAppHealthByShopRef('ldxp', 'tok2', 'failing', 'boom')
      row = repo.getById('m2')
      expect(row?.healthStatus).toBe('failing')
      expect(row?.healthCheckedAt).toBe(successAt)
      repo.setAppHealthByShopRef('ldxp', 'tok2', 'healthy')
      row = repo.getById('m2')
      expect(row?.healthStatus).toBe('healthy')
      expect(row?.healthCheckedAt).not.toBe(successAt)
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

function normalizedRow(
  partial: {
    id: string
    name: string
    shop_url?: string | null
    entry_url?: string | null
    shop_platform?: string | null
    shop_token?: string | null
    offer_count?: number
    source_name?: string | null
  }
) {
  const platform = partial.shop_platform ?? null
  const token = partial.shop_token ?? null
  return {
    id: partial.id,
    name: partial.name,
    store_name: partial.name,
    host: null,
    shop_url: partial.shop_url ?? null,
    entry_url: partial.entry_url ?? null,
    source_id: null,
    source_name: partial.source_name ?? null,
    collector_kind: null,
    health_status: null,
    offer_count: partial.offer_count ?? 0,
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
    fetched_at: new Date().toISOString(),
    raw_json: '{}',
    ldxp_token: platform === 'ldxp' ? token : null,
    shop_platform: platform,
    shop_token: token,
    name_norm: partial.name.toLowerCase(),
    _shopRefDerived: !!(platform && token)
  }
}

describe('MerchantsRepo identity dedupe', () => {
  it('reuses existing id when second source has same shop ref', () => {
    const { db } = openDatabase({ filePath: ':memory:' })
    try {
      const repo = new MerchantsRepo(db)
      repo.upsertMany([
        normalizedRow({
          id: 'priceai-1',
          name: '奥特曼',
          shop_platform: 'ldxp',
          shop_token: 'TOK1',
          shop_url: 'https://pay.ldxp.cn/shop/TOK1',
          offer_count: 20,
          source_name: 'PriceAI'
        })
      ])
      const n = repo.upsertMany([
        normalizedRow({
          id: 'nodebits-uuid-1',
          name: '奥特曼-nb',
          shop_platform: 'ldxp',
          shop_token: 'tok1',
          shop_url: 'https://pay.ldxp.cn/shop/TOK1/',
          offer_count: 5,
          source_name: 'NodeBits'
        })
      ])
      expect(n).toBe(1)
      expect(repo.count()).toBe(1)
      expect(repo.getById('priceai-1')).not.toBeNull()
      expect(repo.getById('nodebits-uuid-1')).toBeNull()
      // Cross-id reuse merges catalog: keep max offer_count, union sources
      expect(repo.getById('priceai-1')?.offerCount).toBe(20)
      const src = repo.getById('priceai-1')?.sourceName ?? ''
      expect(src).toContain('PriceAI')
      expect(src).toContain('NodeBits')
    } finally {
      closeDatabase(db)
    }
  })

  it('merges by same normalized entry_url without shop ref', () => {
    const { db } = openDatabase({ filePath: ':memory:' })
    try {
      const repo = new MerchantsRepo(db)
      repo.upsertMany([
        normalizedRow({
          id: 'a',
          name: '入口店',
          entry_url: 'https://Example.COM/shop/1'
        })
      ])
      repo.upsertMany([
        normalizedRow({
          id: 'b',
          name: '入口店2',
          entry_url: 'https://example.com/shop/1/'
        })
      ])
      expect(repo.count()).toBe(1)
      expect(repo.getById('a')).not.toBeNull()
      expect(repo.getById('b')).toBeNull()
    } finally {
      closeDatabase(db)
    }
  })

  it('dedupeExisting merges historical dups and rehomes favorites', () => {
    const { db } = openDatabase({ filePath: ':memory:' })
    try {
      const repo = new MerchantsRepo(db)
      insertMerchant(db, {
        id: 'keep',
        name: '主档',
        shopPlatform: 'ldxp',
        shopToken: 'SAME',
        offerCount: 1
      })
      insertMerchant(db, {
        id: 'nodebits-dup',
        name: '重复',
        shopPlatform: 'ldxp',
        shopToken: 'same',
        offerCount: 9
      })
      db.prepare(
        `INSERT INTO favorites (target_type, target_id, note, created_at) VALUES ('merchant', ?, NULL, ?)`
      ).run('nodebits-dup', hoursAgo(1))
      db.prepare(
        `INSERT INTO shop_products (
           id, source, merchant_id, source_shop_token, source_goods_key,
           title, price, currency, stock, fetched_at
         ) VALUES ('ldxp:same:g1', 'ldxp', 'nodebits-dup', 'same', 'g1', 'x', 1, 'CNY', 1, ?)`
      ).run(hoursAgo(1))

      const deleted = repo.dedupeExisting()
      expect(deleted).toBe(1)
      expect(repo.count()).toBe(1)
      expect(repo.getById('keep')).not.toBeNull()
      expect(repo.getById('nodebits-dup')).toBeNull()

      const fav = db
        .prepare(
          `SELECT target_id FROM favorites WHERE target_type = 'merchant' AND target_id = 'keep'`
        )
        .get() as { target_id: string } | undefined
      expect(fav?.target_id).toBe('keep')

      const sp = db
        .prepare(`SELECT merchant_id FROM shop_products WHERE id = 'ldxp:same:g1'`)
        .get() as { merchant_id: string }
      expect(sp.merchant_id).toBe('keep')
    } finally {
      closeDatabase(db)
    }
  })

  it('collapses same-ref rows inside one upsertMany batch', () => {
    const { db } = openDatabase({ filePath: ':memory:' })
    try {
      const repo = new MerchantsRepo(db)
      const n = repo.upsertMany([
        normalizedRow({
          id: 'm1',
          name: 'A',
          shop_platform: 'ldxp',
          shop_token: 'T1',
          shop_url: 'https://pay.ldxp.cn/shop/T1',
          offer_count: 2
        }),
        normalizedRow({
          id: 'nodebits-m1',
          name: 'B',
          shop_platform: 'ldxp',
          shop_token: 'T1',
          shop_url: 'https://pay.ldxp.cn/shop/T1',
          offer_count: 8
        })
      ])
      expect(n).toBe(1)
      expect(repo.count()).toBe(1)
      expect(repo.getById('m1')).not.toBeNull()
      expect(repo.getById('nodebits-m1')).toBeNull()
      expect(repo.getById('m1')?.offerCount).toBe(8)
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
