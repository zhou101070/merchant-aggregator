import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { openDatabase, closeDatabase } from '../../../db/connection'
import { MerchantsRepo } from '../../../db/repositories/merchants-repo'
import {
  enrichFromExternalUrl,
  hasMerchantExternalLink,
  NODEBITS_ID_PREFIX,
  nodebitsMerchantId,
  normalizeNodebitsMerchant
} from '../normalize'
import { nodebitsShopsResponseSchema, type NodebitsShopRaw } from '../zod'

const here = dirname(fileURLToPath(import.meta.url))
const shopsFixture = JSON.parse(readFileSync(join(here, '../fixtures/shops.json'), 'utf8'))

describe('nodebits zod fixtures', () => {
  it('validates shops fixture', () => {
    const parsed = nodebitsShopsResponseSchema.parse(shopsFixture)
    expect(parsed.shops).toHaveLength(4)
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

describe('enrichFromExternalUrl', () => {
  it('parses host from full shop URL', () => {
    const e = enrichFromExternalUrl('https://pay.ldxp.cn/shop/ABC12345')
    expect(e.shopUrl).toBe('https://pay.ldxp.cn/shop/ABC12345')
    expect(e.entryUrl).toBe('https://pay.ldxp.cn/shop/ABC12345')
    expect(e.host).toBe('pay.ldxp.cn')
  })

  it('returns null links when url missing', () => {
    const e = enrichFromExternalUrl(null)
    expect(e.shopUrl).toBeNull()
    expect(e.entryUrl).toBeNull()
    expect(e.host).toBeNull()
  })
})

describe('normalizeNodebitsMerchant', () => {
  const shops = nodebitsShopsResponseSchema.parse(shopsFixture).shops as NodebitsShopRaw[]
  const opts = { fetchedAt: '2026-07-18T06:00:00.000Z', generatedAt: '2026-07-18T06:00:00.000Z' }

  it('derives ldxp shop ref from /go externalUrl', () => {
    const shop = shops.find((s) => s.id.startsWith('1111'))!
    const row = normalizeNodebitsMerchant(shop, {
      ...opts,
      externalUrl: 'https://pay.ldxp.cn/shop/ABC12345'
    })
    expect(row.id).toBe(`${NODEBITS_ID_PREFIX}${shop.id}`)
    expect(row.shop_url).toBe('https://pay.ldxp.cn/shop/ABC12345')
    expect(row.shop_platform).toBe('ldxp')
    expect(row.shop_token).toBe('ABC12345')
    expect(row.ldxp_token).toBe('ABC12345')
    expect(row._shopRefDerived).toBe(true)
    expect(row.name_norm).toBe('nodebits 链动店')
    expect(row.offer_count).toBe(0)
    expect(JSON.parse(row.platforms_json)).toEqual(expect.arrayContaining(['ChatGPT']))
    const raw = JSON.parse(row.raw_json) as { shop: { id: string }; externalUrl: string }
    expect(raw.shop.id).toBe(shop.id)
    expect(raw.externalUrl).toBe('https://pay.ldxp.cn/shop/ABC12345')
  })

  it('keeps entry-only merchants with external link but no shopApi ref', () => {
    const shop = shops.find((s) => s.id.startsWith('2222'))!
    const row = normalizeNodebitsMerchant(shop, {
      ...opts,
      externalUrl: 'https://example-shop.test/p/99'
    })
    expect(hasMerchantExternalLink(row)).toBe(true)
    expect(row.entry_url).toBe('https://example-shop.test/p/99')
    expect(row.shop_url).toBe('https://example-shop.test/p/99')
    expect(row.shop_platform).toBeNull()
  })

  it('marks no-link merchants as not having external link', () => {
    const shop = shops.find((s) => s.id.startsWith('3333'))!
    const row = normalizeNodebitsMerchant(shop, { ...opts, externalUrl: null })
    expect(hasMerchantExternalLink(row)).toBe(false)
  })

  it('upserts nodebits rows into merchants table without colliding on id prefix', () => {
    const { db } = openDatabase({ filePath: ':memory:' })
    try {
      const repo = new MerchantsRepo(db)
      const urls: Record<string, string | null> = {
        '11111111-1111-1111-1111-111111111111': 'https://pay.ldxp.cn/shop/ABC12345',
        '22222222-2222-2222-2222-222222222222': 'https://example-shop.test/p/99',
        '33333333-3333-3333-3333-333333333333': null
      }
      const keep = shops
        .filter((s) => !s.is_test)
        .map((s) =>
          normalizeNodebitsMerchant(s, {
            ...opts,
            externalUrl: urls[s.id] ?? null
          })
        )
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
