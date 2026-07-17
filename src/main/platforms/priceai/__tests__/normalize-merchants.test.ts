import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { openDatabase, closeDatabase } from '../../../db/connection'
import { MerchantsRepo } from '../../../db/repositories/merchants-repo'
import { normalizeMerchant, deriveLdxpToken, deriveShopRef } from '../normalize'
import { priceaiMerchantsPageSchema } from '../zod'

const here = dirname(fileURLToPath(import.meta.url))
const fixture = JSON.parse(readFileSync(join(here, '../fixtures/merchants-page.json'), 'utf8'))

describe('priceai merchants normalize', () => {
  it('validates fixture with zod', () => {
    const parsed = priceaiMerchantsPageSchema.parse(fixture)
    expect(parsed.rows).toHaveLength(2)
    expect(parsed.degraded).toBe(false)
  })

  it('derives ldxp token from shop url', () => {
    expect(
      deriveLdxpToken({
        host: 'pay.ldxp.cn',
        shopUrl: 'https://pay.ldxp.cn/shop/PAXOVOVJ'
      })
    ).toBe('PAXOVOVJ')
  })

  it('does not write catfk token into ldxp_token (wrong-platform bugfix)', () => {
    expect(
      deriveLdxpToken({
        host: 'catfk.com',
        shopUrl: 'https://catfk.com/shop/hththt'
      })
    ).toBeNull()
    const ref = deriveShopRef({
      host: 'catfk.com',
      shopUrl: 'https://catfk.com/shop/hththt'
    })
    expect(ref).toMatchObject({
      shop_platform: 'catfk',
      shop_token: 'hththt',
      ldxp_token: null
    })
  })

  it('maps API fields to db row + name_norm', () => {
    const page = priceaiMerchantsPageSchema.parse(fixture)
    const row = normalizeMerchant(page.rows[0], {
      fetchedAt: '2026-07-17T06:00:00.000Z',
      generatedAt: page.generatedAt
    })
    expect(row.id).toBe('merchant-41c7037cc0c7151045308a4cb1d116f1')
    expect(row.ldxp_token).toBe('PAXOVOVJ')
    expect(row.shop_platform).toBe('ldxp')
    expect(row.shop_token).toBe('PAXOVOVJ')
    expect(row._shopRefDerived).toBe(true)
    expect(row.has_platform_aftersales).toBe(1)
    expect(row.name_norm).toBe('奥特曼严选')
    expect(JSON.parse(row.platforms_json)).toContain('ChatGPT')
  })

  it('upserts into merchants table', () => {
    const { db } = openDatabase({ filePath: ':memory:' })
    try {
      const repo = new MerchantsRepo(db)
      const page = priceaiMerchantsPageSchema.parse(fixture)
      const rows = page.rows.map((r) =>
        normalizeMerchant(r, {
          fetchedAt: '2026-07-17T06:00:00.000Z',
          generatedAt: page.generatedAt
        })
      )
      expect(repo.upsertMany(rows)).toBe(2)
      expect(repo.count()).toBe(2)
      const one = repo.getById(rows[0].id)
      expect(one?.ldxpToken).toBe('PAXOVOVJ')
      expect(one?.shopPlatform).toBe('ldxp')
      expect(one?.shopToken).toBe('PAXOVOVJ')
      expect(one?.platforms).toContain('Claude')
      const listed = repo.list({ q: '奥特曼', offset: 0, limit: 10 })
      expect(listed.total).toBe(1)
      expect(listed.rows[0].name).toBe('奥特曼严选')
    } finally {
      closeDatabase(db)
    }
  })
})
