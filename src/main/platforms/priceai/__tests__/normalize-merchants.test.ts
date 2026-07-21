import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { openDatabase, closeDatabase } from '../../../db/connection'
import { MerchantsRepo } from '../../../db/repositories/merchants-repo'
import { normalizeMerchant, deriveShopRef, hasMerchantExternalLink } from '../normalize'
import { priceaiMerchantsPageSchema } from '../zod'

const here = dirname(fileURLToPath(import.meta.url))
const fixture = JSON.parse(readFileSync(join(here, '../fixtures/merchants-page.json'), 'utf8'))

describe('priceai merchants normalize', () => {
  it('validates fixture with zod', () => {
    const parsed = priceaiMerchantsPageSchema.parse(fixture)
    expect(parsed.rows).toHaveLength(2)
    expect(parsed.degraded).toBe(false)
  })

  it('accepts live payload that omits degraded (defaults false)', () => {
    const { degraded: _omit, ...withoutDegraded } = fixture as {
      degraded?: boolean
      [k: string]: unknown
    }
    void _omit
    const parsed = priceaiMerchantsPageSchema.parse(withoutDegraded)
    expect(parsed.degraded).toBe(false)
    expect(parsed.rows).toHaveLength(2)
  })

  it('derives ldxp shop ref from shop url', () => {
    expect(
      deriveShopRef({
        host: 'pay.ldxp.cn',
        shopUrl: 'https://pay.ldxp.cn/shop/PAXOVOVJ'
      })
    ).toMatchObject({
      shop_platform: 'ldxp',
      shop_token: 'PAXOVOVJ',
      ldxp_token: 'PAXOVOVJ'
    })
  })

  it('does not write catfk token into ldxp_token (wrong-platform bugfix)', () => {
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

  it('derives dujiao shop ref from collector_kind + host', () => {
    expect(
      deriveShopRef({
        host: 'flyai.qzz.io',
        entryUrl: 'https://flyai.qzz.io/',
        collectorKind: 'dujiao'
      })
    ).toMatchObject({
      shop_platform: 'dujiao',
      shop_token: 'flyai.qzz.io',
      ldxp_token: null
    })
  })

  it('does not invent dujiao ref without host', () => {
    expect(deriveShopRef({ collectorKind: 'dujiao' })).toBeNull()
  })

  it('does not derive yiciyuan ref from soft kami without path fingerprint', () => {
    expect(
      deriveShopRef({
        host: 'web3chirou.com',
        entryUrl: 'https://web3chirou.com/',
        collectorKind: 'kami'
      })
    ).toBeNull()
  })

  it('derives yiciyuan ref from kami + /item/ path hint', () => {
    expect(
      deriveShopRef({
        host: 'wiki123.top',
        entryUrl: 'https://wiki123.top/item/8',
        collectorKind: 'kami'
      })
    ).toMatchObject({
      shop_platform: 'yiciyuan',
      shop_token: 'wiki123.top',
      ldxp_token: null
    })
  })

  it('does not invent yiciyuan ref without host', () => {
    expect(deriveShopRef({ collectorKind: 'kami' })).toBeNull()
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

  it('hasMerchantExternalLink requires shop_url or entry_url', () => {
    expect(hasMerchantExternalLink({ shop_url: 'https://a.com', entry_url: null })).toBe(true)
    expect(hasMerchantExternalLink({ shop_url: null, entry_url: 'https://b.com' })).toBe(true)
    expect(hasMerchantExternalLink({ shop_url: null, entry_url: null })).toBe(false)
    expect(hasMerchantExternalLink({ shop_url: '', entry_url: '  ' })).toBe(false)
  })

  it('deleteWithoutExternalLinks removes no-link merchants and merchant favorites/recent', () => {
    const { db } = openDatabase({ filePath: ':memory:' })
    try {
      const repo = new MerchantsRepo(db)
      const page = priceaiMerchantsPageSchema.parse(fixture)
      const withLink = normalizeMerchant(page.rows[0], {
        fetchedAt: '2026-07-17T06:00:00.000Z',
        generatedAt: page.generatedAt
      })
      const noLink = {
        ...withLink,
        id: 'merchant-no-link',
        name: 'JZ',
        shop_url: null,
        entry_url: null,
        host: null,
        source_id: null,
        shop_platform: null,
        shop_token: null,
        ldxp_token: null,
        _shopRefDerived: false
      }
      repo.upsertMany([withLink, noLink])
      db.prepare(
        `INSERT INTO favorites (target_type, target_id, note, created_at) VALUES ('merchant', ?, NULL, ?)`
      ).run(noLink.id, '2026-07-17T06:00:00.000Z')
      db.prepare(
        `INSERT INTO recent_views (target_type, target_id, title_snapshot, viewed_at) VALUES ('merchant', ?, 'JZ', ?)`
      ).run(noLink.id, '2026-07-17T06:00:00.000Z')

      expect(repo.deleteWithoutExternalLinks()).toBe(1)
      expect(repo.count()).toBe(1)
      expect(repo.getById(withLink.id)?.id).toBe(withLink.id)
      expect(repo.getById(noLink.id)).toBeNull()
      const fav = db
        .prepare(`SELECT COUNT(*) AS c FROM favorites WHERE target_id = ?`)
        .get(noLink.id) as { c: number }
      const recent = db
        .prepare(`SELECT COUNT(*) AS c FROM recent_views WHERE target_id = ?`)
        .get(noLink.id) as { c: number }
      expect(fav.c).toBe(0)
      expect(recent.c).toBe(0)
    } finally {
      closeDatabase(db)
    }
  })
})
