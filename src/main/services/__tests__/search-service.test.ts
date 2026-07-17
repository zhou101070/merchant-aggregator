import { describe, expect, it } from 'vitest'
import { closeDatabase, openDatabase } from '../../db/connection'
import { SearchService } from '../search-service'

function seedMerchants(
  db: ReturnType<typeof openDatabase>['db'],
  rows: Array<{ id: string; name: string; token: string }>
): void {
  for (const r of rows) {
    db.prepare(
      `INSERT INTO merchants (id, name, fetched_at, health_status, offer_count, in_stock_count, out_of_stock_count, product_count, platform_count, platforms_json, product_types_json, has_platform_aftersales, ldxp_token)
       VALUES (?, ?, 't', 'healthy', 0, 0, 0, 0, 0, '[]', '[]', 0, ?)`
    ).run(r.id, r.name, r.token)
  }
}

function seedProducts(
  db: ReturnType<typeof openDatabase>['db'],
  rows: Array<{
    id: string
    merchantId: string
    token: string
    key: string
    title: string
    price: number
    stock?: number
  }>
): void {
  for (const r of rows) {
    db.prepare(
      `INSERT INTO shop_products (id, source, merchant_id, source_shop_token, source_goods_key, title, price, currency, stock, fetched_at)
       VALUES (?, 'ldxp', ?, ?, ?, ?, ?, 'CNY', ?, 't')`
    ).run(r.id, r.merchantId, r.token, r.key, r.title, r.price, r.stock ?? 5)
  }
}

describe('SearchService local-only shop_products', () => {
  it('returns SHOP_PRODUCTS_NOT_SYNCED when empty', () => {
    const { db } = openDatabase({ filePath: ':memory:' })
    try {
      const search = new SearchService(db)
      const res = search.query({ q: 'claude' })
      expect(res.emptyReason).toBe('SHOP_PRODUCTS_NOT_SYNCED')
      expect(res.hits).toEqual([])
    } finally {
      closeDatabase(db)
    }
  })

  it('ranks title match and supports price sort', () => {
    const { db } = openDatabase({ filePath: ':memory:' })
    try {
      seedMerchants(db, [{ id: 'm1', name: '好店', token: 'TOK1' }])
      seedProducts(db, [
        {
          id: 's1',
          merchantId: 'm1',
          token: 'TOK1',
          key: 'g1',
          title: 'Claude Pro 月卡',
          price: 80
        },
        {
          id: 's2',
          merchantId: 'm1',
          token: 'TOK1',
          key: 'g2',
          title: '其他商品',
          price: 10,
          stock: 1
        }
      ])

      const search = new SearchService(db)
      const byScore = search.query({ q: 'Claude Pro', sort: 'score', limit: 10, offset: 0 })
      expect(byScore.total).toBeGreaterThanOrEqual(1)
      expect(byScore.hits[0].title).toContain('Claude')

      const byPrice = search.query({ q: '', sort: 'price', sortDir: 'asc', limit: 10, offset: 0 })
      expect(byPrice.hits[0].price).toBe(10)
      expect(byPrice.total).toBe(2)
    } finally {
      closeDatabase(db)
    }
  })

  it('browse empty query reports full catalog total and pages past former 3000 cap', () => {
    const { db } = openDatabase({ filePath: ':memory:' })
    try {
      seedMerchants(db, [{ id: 'm1', name: '好店', token: 'TOK1' }])
      const rows = Array.from({ length: 45 }, (_, i) => ({
        id: `s${i}`,
        merchantId: 'm1',
        token: 'TOK1',
        key: `g${i}`,
        title: `商品 ${i}`,
        price: i + 1,
        stock: 1
      }))
      seedProducts(db, rows)

      const search = new SearchService(db)
      const page0 = search.query({ q: '', sort: 'price', sortDir: 'asc', limit: 20, offset: 0 })
      expect(page0.total).toBe(45)
      expect(page0.hits).toHaveLength(20)
      expect(page0.hits[0].price).toBe(1)

      const page2 = search.query({ q: '', sort: 'price', sortDir: 'asc', limit: 20, offset: 40 })
      expect(page2.total).toBe(45)
      expect(page2.hits).toHaveLength(5)
      expect(page2.hits[0].price).toBe(41)
    } finally {
      closeDatabase(db)
    }
  })

  it('matches multi-token queries out of order (not fixed contiguous phrase)', () => {
    const { db } = openDatabase({ filePath: ':memory:' })
    try {
      seedMerchants(db, [{ id: 'm1', name: '好店', token: 'TOK1' }])
      seedProducts(db, [
        {
          id: 's1',
          merchantId: 'm1',
          token: 'TOK1',
          key: 'g1',
          title: 'Claude Pro 月卡 质保',
          price: 80
        },
        {
          id: 's2',
          merchantId: 'm1',
          token: 'TOK1',
          key: 'g2',
          title: 'Outlook 成品邮箱',
          price: 5
        }
      ])

      const search = new SearchService(db)
      // Previously required contiguous "Claude 月卡" substring — would miss this title
      const res = search.query({ q: 'Claude 月卡', sort: 'score' })
      expect(res.total).toBe(1)
      expect(res.hits[0].title).toContain('Claude')
      expect(res.hits.some((h) => h.title.includes('Outlook'))).toBe(false)
    } finally {
      closeDatabase(db)
    }
  })

  it('splits glued Latin+CJK query (Claude月卡)', () => {
    const { db } = openDatabase({ filePath: ':memory:' })
    try {
      seedMerchants(db, [{ id: 'm1', name: '好店', token: 'TOK1' }])
      seedProducts(db, [
        {
          id: 's1',
          merchantId: 'm1',
          token: 'TOK1',
          key: 'g1',
          title: '【Claude】Pro 月卡',
          price: 80
        },
        {
          id: 's2',
          merchantId: 'm1',
          token: 'TOK1',
          key: 'g2',
          title: 'GPT Plus',
          price: 90
        }
      ])

      const search = new SearchService(db)
      const res = search.query({ q: 'Claude月卡' })
      expect(res.total).toBe(1)
      expect(res.hits[0].title).toMatch(/Claude/i)
    } finally {
      closeDatabase(db)
    }
  })

  it('ranks full phrase and full token coverage above partial OR hits', () => {
    const { db } = openDatabase({ filePath: ':memory:' })
    try {
      seedMerchants(db, [
        { id: 'm1', name: '好店', token: 'TOK1' },
        { id: 'm2', name: 'Claude 专营', token: 'TOK2' }
      ])
      seedProducts(db, [
        {
          id: 's1',
          merchantId: 'm1',
          token: 'TOK1',
          key: 'g1',
          title: 'Claude Pro 月卡',
          price: 80
        },
        {
          id: 's2',
          merchantId: 'm2',
          token: 'TOK2',
          key: 'g2',
          title: '无关商品',
          price: 1
        },
        {
          id: 's3',
          merchantId: 'm1',
          token: 'TOK1',
          key: 'g3',
          title: 'Claude 年卡',
          price: 200
        }
      ])

      const search = new SearchService(db)
      // AND: both tokens in title for s1; s3 has Claude but not 月卡; s2 only merchant name Claude
      const res = search.query({ q: 'Claude 月卡', sort: 'score' })
      expect(res.hits[0].title).toBe('Claude Pro 月卡')
      expect(res.hits.every((h) => !h.title.includes('无关'))).toBe(true)
    } finally {
      closeDatabase(db)
    }
  })

  it('OR fallback when multi-token AND has no hit', () => {
    const { db } = openDatabase({ filePath: ':memory:' })
    try {
      seedMerchants(db, [{ id: 'm1', name: '好店', token: 'TOK1' }])
      seedProducts(db, [
        {
          id: 's1',
          merchantId: 'm1',
          token: 'TOK1',
          key: 'g1',
          title: 'Claude Pro 季卡',
          price: 200
        },
        {
          id: 's2',
          merchantId: 'm1',
          token: 'TOK1',
          key: 'g2',
          title: 'Outlook 邮箱',
          price: 5
        }
      ])

      const search = new SearchService(db)
      // 月卡 not present → AND empty → OR still surfaces Claude titles
      const res = search.query({ q: 'Claude 月卡' })
      expect(res.total).toBeGreaterThanOrEqual(1)
      expect(res.hits[0].title).toMatch(/Claude/i)
    } finally {
      closeDatabase(db)
    }
  })

  it('weak compare filters by title tokens and returns notice', () => {
    const { db } = openDatabase({ filePath: ':memory:' })
    try {
      seedMerchants(db, [
        { id: 'm1', name: '好店', token: 'TOK1' },
        { id: 'm2', name: '乙店', token: 'TOK2' }
      ])
      seedProducts(db, [
        {
          id: 's1',
          merchantId: 'm1',
          token: 'TOK1',
          key: 'g1',
          title: 'Claude Pro 月卡 质保',
          price: 80
        },
        {
          id: 's2',
          merchantId: 'm2',
          token: 'TOK2',
          key: 'g2',
          title: 'Claude Pro 季卡',
          price: 200
        },
        {
          id: 's3',
          merchantId: 'm1',
          token: 'TOK1',
          key: 'g3',
          title: 'Outlook 成品邮箱',
          price: 5
        }
      ])

      const search = new SearchService(db)
      const cmp = search.compare({ titleNorm: 'Claude Pro 月卡 质保' })
      expect(cmp.mode).toBe('weak_title')
      expect(cmp.notice).toBeTruthy()
      expect(cmp.rows.length).toBeGreaterThanOrEqual(2)
      expect(cmp.rows.every((r) => /claude|pro/i.test(r.title))).toBe(true)
      expect(cmp.rows.some((r) => r.title.includes('Outlook'))).toBe(false)
      // Similar Claude Pro variants should appear for cross-shop compare
      expect(cmp.rows.some((r) => r.title.includes('季卡'))).toBe(true)
    } finally {
      closeDatabase(db)
    }
  })

  it('hides prices at or below 0.02', () => {
    const { db } = openDatabase({ filePath: ':memory:' })
    try {
      seedMerchants(db, [{ id: 'm1', name: '好店', token: 'TOK1' }])
      seedProducts(db, [
        {
          id: 's1',
          merchantId: 'm1',
          token: 'TOK1',
          key: 'g1',
          title: '占位 0.01',
          price: 0.01
        },
        {
          id: 's2',
          merchantId: 'm1',
          token: 'TOK1',
          key: 'g2',
          title: '占位 0.02',
          price: 0.02
        },
        {
          id: 's3',
          merchantId: 'm1',
          token: 'TOK1',
          key: 'g3',
          title: '正常 0.03',
          price: 0.03
        },
        {
          id: 's4',
          merchantId: 'm1',
          token: 'TOK1',
          key: 'g4',
          title: '正常 1',
          price: 1
        }
      ])

      const search = new SearchService(db)
      const res = search.query({ q: '', sort: 'price', sortDir: 'asc' })
      const prices = res.hits.map((h) => h.price)
      expect(prices).toEqual([0.03, 1])
      expect(res.total).toBe(2)
    } finally {
      closeDatabase(db)
    }
  })

  it('titleContains excludes negated terms (非/不含 Plus)', () => {
    const { db } = openDatabase({ filePath: ':memory:' })
    try {
      seedMerchants(db, [{ id: 'm1', name: '好店', token: 'TOK1' }])
      seedProducts(db, [
        {
          id: 's1',
          merchantId: 'm1',
          token: 'TOK1',
          key: 'g1',
          title: 'ChatGPT plus/pro 国内镜像站',
          price: 1
        },
        {
          id: 's2',
          merchantId: 'm1',
          token: 'TOK1',
          key: 'g2',
          title: 'Gpt Free | 非PLUS | outlook',
          price: 0.49
        },
        {
          id: 's3',
          merchantId: 'm1',
          token: 'TOK1',
          key: 'g3',
          title: '全新微软邮箱，已注册好ChatGPT (不含plus)',
          price: 0.54
        },
        {
          id: 's4',
          merchantId: 'm1',
          token: 'TOK1',
          key: 'g4',
          title: 'iCloud 隐私邮箱 开plus（绑定专用）',
          price: 0.77
        },
        {
          id: 's5',
          merchantId: 'm1',
          token: 'TOK1',
          key: 'g5',
          title: 'Claude 月卡 无 Plus',
          price: 2
        }
      ])

      const search = new SearchService(db)
      const res = search.query({ titleContains: ['Plus'], sort: 'price', sortDir: 'asc' })
      const titles = res.hits.map((h) => h.title)
      expect(titles).toContain('ChatGPT plus/pro 国内镜像站')
      expect(titles).toContain('iCloud 隐私邮箱 开plus（绑定专用）')
      expect(titles.some((t) => /非PLUS/i.test(t))).toBe(false)
      expect(titles.some((t) => t.includes('不含plus'))).toBe(false)
      expect(titles.some((t) => t.includes('无 Plus'))).toBe(false)
      expect(res.total).toBe(2)
    } finally {
      closeDatabase(db)
    }
  })
})
