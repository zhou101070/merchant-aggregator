import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { openDatabase, closeDatabase } from '../../../db/connection'
import { MerchantsRepo } from '../../../db/repositories/merchants-repo'
import {
  enrichFromProducts,
  hasMerchantExternalLink,
  NODEBITS_ID_PREFIX,
  nodebitsMerchantId,
  normalizeNodebitsMerchant
} from '../normalize'
import {
  nodebitsProductsPageSchema,
  nodebitsShopsResponseSchema,
  type NodebitsProductRaw,
  type NodebitsShopRaw
} from '../zod'

const here = dirname(fileURLToPath(import.meta.url))
const shopsFixture = JSON.parse(readFileSync(join(here, '../fixtures/shops.json'), 'utf8'))
const productsFixture = JSON.parse(
  readFileSync(join(here, '../fixtures/products-page.json'), 'utf8')
)

describe('nodebits zod fixtures', () => {
  it('validates shops fixture', () => {
    const parsed = nodebitsShopsResponseSchema.parse(shopsFixture)
    expect(parsed.shops).toHaveLength(4)
  })

  it('validates products fixture', () => {
    const parsed = nodebitsProductsPageSchema.parse(productsFixture)
    expect(parsed.products).toHaveLength(3)
    expect(parsed.total).toBe(3)
  })
})

describe('nodebitsMerchantId', () => {
  it('prefixes uuid ids', () => {
    expect(nodebitsMerchantId('abc')).toBe(`${NODEBITS_ID_PREFIX}abc`)
  })

  it('is idempotent when already prefixed', () => {
    const id = `${NODEBITS_ID_PREFIX}abc`
    expect(nodebitsMerchantId(id)).toBe(id)
  })
})

describe('enrichFromProducts', () => {
  it('prefers raw_text.shopUrl and maps ldxp source to shopApi', () => {
    const products = nodebitsProductsPageSchema.parse(productsFixture).products
    const ldxp = products.filter((p) => p.shop_id.startsWith('1111'))
    const e = enrichFromProducts(ldxp)
    expect(e.shopUrl).toBe('https://pay.ldxp.cn/shop/ABC12345')
    expect(e.entryUrl).toBe('https://pay.ldxp.cn/shop/ABC12345')
    expect(e.host).toBe('pay.ldxp.cn')
    expect(e.collectorKind).toBe('shopApi')
    expect(e.sourceLabel).toBe('ldxp')
    expect(e.productCount).toBe(1)
    expect(e.inStockCount).toBe(1)
    expect(e.productTypes).toContain('成品账号')
  })

  it('falls back to product_url as entry when raw_text lacks shopUrl', () => {
    const products = nodebitsProductsPageSchema.parse(productsFixture).products
    const entryOnly = products.filter((p) => p.shop_id.startsWith('2222'))
    const e = enrichFromProducts(entryOnly)
    expect(e.shopUrl).toBeNull()
    expect(e.entryUrl).toBe('https://example-shop.test/p/99')
    expect(e.host).toBe('example-shop.test')
    expect(e.outOfStockCount).toBe(1)
  })

  it('returns null links when products have no urls', () => {
    const products = nodebitsProductsPageSchema.parse(productsFixture).products
    const none = products.filter((p) => p.shop_id.startsWith('3333'))
    const e = enrichFromProducts(none)
    expect(e.shopUrl).toBeNull()
    expect(e.entryUrl).toBeNull()
    expect(e.host).toBeNull()
  })
})

describe('normalizeNodebitsMerchant', () => {
  const shops = nodebitsShopsResponseSchema.parse(shopsFixture).shops as NodebitsShopRaw[]
  const products = nodebitsProductsPageSchema.parse(productsFixture).products as NodebitsProductRaw[]
  const byShop = new Map<string, NodebitsProductRaw[]>()
  for (const p of products) {
    const list = byShop.get(p.shop_id)
    if (list) list.push(p)
    else byShop.set(p.shop_id, [p])
  }
  const opts = { fetchedAt: '2026-07-18T06:00:00.000Z', generatedAt: '2026-07-18T06:00:00.000Z' }

  it('derives ldxp shop ref from product-enriched shopUrl', () => {
    const shop = shops.find((s) => s.id.startsWith('1111'))!
    const row = normalizeNodebitsMerchant(shop, byShop.get(shop.id) ?? [], opts)
    expect(row.id).toBe(`${NODEBITS_ID_PREFIX}${shop.id}`)
    expect(row.shop_url).toBe('https://pay.ldxp.cn/shop/ABC12345')
    expect(row.shop_platform).toBe('ldxp')
    expect(row.shop_token).toBe('ABC12345')
    expect(row.ldxp_token).toBe('ABC12345')
    expect(row._shopRefDerived).toBe(true)
    expect(row.name_norm).toBe('nodebits 链动店')
    expect(row.offer_count).toBe(1)
    expect(JSON.parse(row.platforms_json)).toEqual(expect.arrayContaining(['ChatGPT']))
    const raw = JSON.parse(row.raw_json) as { shop: { id: string }; enrichment: unknown }
    expect(raw.shop.id).toBe(shop.id)
  })

  it('keeps entry-only merchants with external link but no shopApi ref', () => {
    const shop = shops.find((s) => s.id.startsWith('2222'))!
    const row = normalizeNodebitsMerchant(shop, byShop.get(shop.id) ?? [], opts)
    expect(hasMerchantExternalLink(row)).toBe(true)
    expect(row.entry_url).toBe('https://example-shop.test/p/99')
    expect(row.shop_url).toBeNull()
    expect(row.shop_platform).toBeNull()
  })

  it('marks no-link merchants as not having external link', () => {
    const shop = shops.find((s) => s.id.startsWith('3333'))!
    const row = normalizeNodebitsMerchant(shop, byShop.get(shop.id) ?? [], opts)
    expect(hasMerchantExternalLink(row)).toBe(false)
  })

  it('upserts nodebits rows into merchants table without colliding on id prefix', () => {
    const { db } = openDatabase({ filePath: ':memory:' })
    try {
      const repo = new MerchantsRepo(db)
      const keep = shops
        .filter((s) => !s.is_test)
        .map((s) => normalizeNodebitsMerchant(s, byShop.get(s.id) ?? [], opts))
        .filter((r) => hasMerchantExternalLink(r))
      expect(keep).toHaveLength(2)
      expect(repo.upsertMany(keep)).toBe(2)
      expect(repo.count()).toBe(2)
      const one = repo.getById(keep[0]!.id)
      expect(one?.id.startsWith(NODEBITS_ID_PREFIX)).toBe(true)
      expect(one?.shopPlatform).toBe('ldxp')
      expect(one?.shopToken).toBe('ABC12345')
    } finally {
      closeDatabase(db)
    }
  })
})
