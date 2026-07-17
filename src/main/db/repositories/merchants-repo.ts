import type Database from 'better-sqlite3'
import { likeContains, tokenizeQuery } from '@shared/lib/search-query'
import {
  knownShopPlatformIds,
  SHOP_PLATFORM_OTHER
} from '@shared/platforms/shop-profiles'
import type { Merchant, MerchantCandidates, MerchantListQuery } from '@shared/types/merchant'
import type { NormalizedMerchantRow } from '../../platforms/priceai/normalize'

interface MerchantRow {
  id: string
  name: string
  store_name: string | null
  host: string | null
  shop_url: string | null
  entry_url: string | null
  source_id: string | null
  source_name: string | null
  collector_kind: string | null
  health_status: string | null
  offer_count: number
  in_stock_count: number
  out_of_stock_count: number
  product_count: number
  platform_count: number
  platforms_json: string
  product_types_json: string
  representative_product: string | null
  representative_offer_title: string | null
  representative_price: number | null
  representative_currency: string | null
  lowest_hit_count: number
  warranty_lowest_hit_count: number
  risk_feedback_count: number
  has_platform_aftersales: number
  shop_created_at: string | null
  included_at: string | null
  last_success_at: string | null
  latest_seen_at: string | null
  consecutive_failures: number
  observation_started_at: string | null
  generated_at: string | null
  fetched_at: string
  raw_json?: string | null
  ldxp_token: string | null
  shop_platform: string | null
  shop_token: string | null
  name_norm?: string | null
  app_health_status?: string | null
  app_health_at?: string | null
  app_health_message?: string | null
  local_product_count?: number
}

const LOCAL_COUNT_COL = `(
  SELECT COUNT(*) FROM shop_products sp WHERE sp.merchant_id = merchants.id
) AS local_product_count`

function freshCutoff(freshHours: number): string {
  return new Date(Date.now() - freshHours * 3_600_000).toISOString()
}

/** Scrapable = shop_platform + shop_token present (PR2 forced). */
const SCRAPABLE_SQL = `(shop_token IS NOT NULL AND shop_token != '' AND shop_platform IS NOT NULL AND shop_platform != '')`

/** 新鲜 = 最近一次刮取成功且在新鲜期内 */
const NEEDS_SYNC_SQL = `
  ${SCRAPABLE_SQL}
  AND NOT (COALESCE(app_health_status, '') = 'healthy' AND COALESCE(app_health_at, '') >= @cutoff)`

/** Derive UI health from local scrape state (app-side). Requires shop_platform + shop_token. */
export function deriveAppHealthStatus(row: {
  shop_platform?: string | null
  shop_token?: string | null
  app_health_status?: string | null
}): string {
  const scrapable = !!(row.shop_platform && row.shop_token)
  if (!scrapable) return 'n/a'
  if (row.app_health_status === 'healthy') return 'healthy'
  if (row.app_health_status === 'failing') return 'failing'
  if (row.app_health_status === 'retrying') return 'retrying'
  return 'never'
}

function parseJsonArray(text: string | null | undefined): string[] {
  if (!text) return []
  try {
    const v = JSON.parse(text) as unknown
    return Array.isArray(v) ? v.map(String) : []
  } catch {
    return []
  }
}

function mapRow(row: MerchantRow): Merchant {
  const shopToken = row.shop_token || row.ldxp_token || null
  const shopPlatform = row.shop_platform || (row.ldxp_token ? 'ldxp' : null)
  return {
    id: row.id,
    name: row.name,
    storeName: row.store_name,
    host: row.host,
    shopUrl: row.shop_url,
    entryUrl: row.entry_url,
    sourceId: row.source_id,
    sourceName: row.source_name,
    collectorKind: row.collector_kind,
    healthStatus: deriveAppHealthStatus(row),
    healthCheckedAt: row.app_health_at ?? null,
    healthMessage: row.app_health_message ?? null,
    upstreamHealth: row.health_status ?? null,
    localProductCount: row.local_product_count ?? 0,
    offerCount: row.offer_count,
    inStockCount: row.in_stock_count,
    outOfStockCount: row.out_of_stock_count,
    productCount: row.product_count,
    platformCount: row.platform_count,
    platforms: parseJsonArray(row.platforms_json),
    productTypes: parseJsonArray(row.product_types_json),
    representativeProduct: row.representative_product,
    representativeOfferTitle: row.representative_offer_title,
    representativePrice: row.representative_price,
    representativeCurrency: row.representative_currency,
    lowestHitCount: row.lowest_hit_count,
    warrantyLowestHitCount: row.warranty_lowest_hit_count,
    riskFeedbackCount: row.risk_feedback_count,
    hasPlatformAftersales: row.has_platform_aftersales === 1,
    shopCreatedAt: row.shop_created_at,
    includedAt: row.included_at,
    lastSuccessAt: row.last_success_at,
    latestSeenAt: row.latest_seen_at,
    consecutiveFailures: row.consecutive_failures,
    observationStartedAt: row.observation_started_at,
    generatedAt: row.generated_at,
    fetchedAt: row.fetched_at,
    ldxpToken: row.ldxp_token || (shopPlatform === 'ldxp' ? shopToken : null),
    shopPlatform,
    shopToken
  }
}

/**
 * Upsert with D19: when _shopRefDerived is false, preserve existing shop_* / ldxp_token.
 */
const UPSERT_SQL = `
INSERT INTO merchants (
  id, name, store_name, host, shop_url, entry_url,
  source_id, source_name, collector_kind, health_status,
  offer_count, in_stock_count, out_of_stock_count, product_count, platform_count,
  platforms_json, product_types_json,
  representative_product, representative_offer_title, representative_price, representative_currency,
  lowest_hit_count, warranty_lowest_hit_count, risk_feedback_count, has_platform_aftersales,
  shop_created_at, included_at, last_success_at, latest_seen_at, consecutive_failures,
  observation_started_at, generated_at, fetched_at, raw_json, ldxp_token, shop_platform, shop_token, name_norm
) VALUES (
  @id, @name, @store_name, @host, @shop_url, @entry_url,
  @source_id, @source_name, @collector_kind, @health_status,
  @offer_count, @in_stock_count, @out_of_stock_count, @product_count, @platform_count,
  @platforms_json, @product_types_json,
  @representative_product, @representative_offer_title, @representative_price, @representative_currency,
  @lowest_hit_count, @warranty_lowest_hit_count, @risk_feedback_count, @has_platform_aftersales,
  @shop_created_at, @included_at, @last_success_at, @latest_seen_at, @consecutive_failures,
  @observation_started_at, @generated_at, @fetched_at, @raw_json, @ldxp_token, @shop_platform, @shop_token, @name_norm
)
ON CONFLICT(id) DO UPDATE SET
  name = excluded.name,
  store_name = excluded.store_name,
  host = excluded.host,
  shop_url = excluded.shop_url,
  entry_url = excluded.entry_url,
  source_id = excluded.source_id,
  source_name = excluded.source_name,
  collector_kind = excluded.collector_kind,
  health_status = excluded.health_status,
  offer_count = excluded.offer_count,
  in_stock_count = excluded.in_stock_count,
  out_of_stock_count = excluded.out_of_stock_count,
  product_count = excluded.product_count,
  platform_count = excluded.platform_count,
  platforms_json = excluded.platforms_json,
  product_types_json = excluded.product_types_json,
  representative_product = excluded.representative_product,
  representative_offer_title = excluded.representative_offer_title,
  representative_price = excluded.representative_price,
  representative_currency = excluded.representative_currency,
  lowest_hit_count = excluded.lowest_hit_count,
  warranty_lowest_hit_count = excluded.warranty_lowest_hit_count,
  risk_feedback_count = excluded.risk_feedback_count,
  has_platform_aftersales = excluded.has_platform_aftersales,
  shop_created_at = excluded.shop_created_at,
  included_at = excluded.included_at,
  last_success_at = excluded.last_success_at,
  latest_seen_at = excluded.latest_seen_at,
  consecutive_failures = excluded.consecutive_failures,
  observation_started_at = excluded.observation_started_at,
  generated_at = excluded.generated_at,
  fetched_at = excluded.fetched_at,
  raw_json = excluded.raw_json,
  name_norm = excluded.name_norm,
  ldxp_token = CASE WHEN @shop_ref_derived = 1 THEN excluded.ldxp_token ELSE merchants.ldxp_token END,
  shop_platform = CASE WHEN @shop_ref_derived = 1 THEN excluded.shop_platform ELSE merchants.shop_platform END,
  shop_token = CASE WHEN @shop_ref_derived = 1 THEN excluded.shop_token ELSE merchants.shop_token END
`

export type ScrapableMerchant = {
  id: string
  name: string
  shopPlatform: string
  shopToken: string
  /** @deprecated dual-fill for ldxp */
  ldxpToken: string
}

export class MerchantsRepo {
  private readonly upsertStmt

  constructor(private readonly db: Database.Database) {
    this.upsertStmt = this.db.prepare(UPSERT_SQL)
  }

  setAppHealth(
    merchantId: string,
    status: 'healthy' | 'failing' | 'retrying',
    message?: string | null
  ): void {
    this.db
      .prepare(
        `UPDATE merchants
         SET app_health_status = ?, app_health_at = ?, app_health_message = ?
         WHERE id = ?`
      )
      .run(status, new Date().toISOString(), message ?? null, merchantId)
  }

  setAppHealthByShopRef(
    platform: string,
    token: string,
    status: 'healthy' | 'failing' | 'retrying',
    message?: string | null
  ): void {
    this.db
      .prepare(
        `UPDATE merchants
         SET app_health_status = ?, app_health_at = ?, app_health_message = ?
         WHERE shop_platform = ? AND shop_token = ?`
      )
      .run(status, new Date().toISOString(), message ?? null, platform, token)
  }

  /** @deprecated use setAppHealthByShopRef */
  setAppHealthByToken(
    token: string,
    status: 'healthy' | 'failing' | 'retrying',
    message?: string | null
  ): void {
    this.setAppHealthByShopRef('ldxp', token, status, message)
  }

  findByShopRef(platform: string, token: string): Merchant | null {
    const row = this.db
      .prepare(
        `SELECT merchants.*, ${LOCAL_COUNT_COL} FROM merchants
         WHERE shop_platform = ? AND shop_token = ?
         LIMIT 1`
      )
      .get(platform, token) as MerchantRow | undefined
    return row ? mapRow(row) : null
  }

  /** Relink orphan shop_products to a merchant after scrape match. */
  relinkShopProducts(platform: string, token: string, merchantId: string): number {
    const r = this.db
      .prepare(
        `UPDATE shop_products
         SET merchant_id = ?
         WHERE source = ? AND source_shop_token = ?
           AND (merchant_id IS NULL OR merchant_id = '')`
      )
      .run(merchantId, platform, token)
    return r.changes
  }

  listScrapableMerchants(): ScrapableMerchant[] {
    return (
      this.db
        .prepare(
          `SELECT id, name, shop_platform AS shopPlatform, shop_token AS shopToken
           FROM merchants
           WHERE ${SCRAPABLE_SQL}
           ORDER BY name ASC`
        )
        .all() as { id: string; name: string; shopPlatform: string; shopToken: string }[]
    ).map((r) => ({
      ...r,
      ldxpToken: r.shopPlatform === 'ldxp' ? r.shopToken : r.shopToken
    }))
  }

  /** @deprecated alias */
  listLdxpMerchants(): { id: string; name: string; ldxpToken: string }[] {
    return this.listScrapableMerchants().map((m) => ({
      id: m.id,
      name: m.name,
      ldxpToken: m.shopToken
    }))
  }

  countScrapable(): number {
    return (
      this.db.prepare(`SELECT COUNT(*) AS c FROM merchants WHERE ${SCRAPABLE_SQL}`).get() as {
        c: number
      }
    ).c
  }

  /** @deprecated alias */
  countLdxp(): number {
    return this.countScrapable()
  }

  count(): number {
    const row = this.db.prepare(`SELECT COUNT(*) AS c FROM merchants`).get() as {
      c: number
    }
    return row.c
  }

  getById(id: string): Merchant | null {
    const row = this.db
      .prepare(`SELECT merchants.*, ${LOCAL_COUNT_COL} FROM merchants WHERE id = ?`)
      .get(id) as MerchantRow | undefined
    return row ? mapRow(row) : null
  }

  listScrapableNeedingSync(opts: {
    freshHours: number
    limit?: number
    /** Only these platform ids (e.g. enabled profiles) */
    platformIds?: string[]
  }): ScrapableMerchant[] {
    const limitSql = opts.limit ? `LIMIT ${Math.max(1, Math.floor(opts.limit))}` : ''
    const params: Record<string, unknown> = { cutoff: freshCutoff(opts.freshHours) }
    let platformFilter = ''
    if (opts.platformIds?.length) {
      const keys = opts.platformIds.map((id, i) => {
        const k = `p${i}`
        params[k] = id
        return `@${k}`
      })
      platformFilter = ` AND shop_platform IN (${keys.join(',')})`
    }
    return (
      this.db
        .prepare(
          `SELECT id, name, shop_platform AS shopPlatform, shop_token AS shopToken FROM merchants
           WHERE ${NEEDS_SYNC_SQL}${platformFilter}
           ORDER BY offer_count DESC
           ${limitSql}`
        )
        .all(params) as {
        id: string
        name: string
        shopPlatform: string
        shopToken: string
      }[]
    ).map((r) => ({
      ...r,
      ldxpToken: r.shopToken
    }))
  }

  /** @deprecated alias */
  listLdxpNeedingSync(opts: {
    freshHours: number
    limit?: number
  }): { id: string; name: string; ldxpToken: string }[] {
    return this.listScrapableNeedingSync(opts).map((m) => ({
      id: m.id,
      name: m.name,
      ldxpToken: m.shopToken
    }))
  }

  candidatesForQuery(q: string, freshHours: number): MerchantCandidates {
    const tokens = tokenizeQuery(q).slice(0, 5)
    if (!tokens.length) return { merchantIds: [], totalMatching: 0, sample: [] }

    const params: Record<string, unknown> = { cutoff: freshCutoff(freshHours) }
    const tokenClauses = tokens.map((t, i) => {
      params[`t${i}`] = likeContains(t)
      const f = `@t${i}`
      return `(name LIKE ${f} ESCAPE '\\' OR store_name LIKE ${f} ESCAPE '\\' OR platforms_json LIKE ${f} ESCAPE '\\'
        OR product_types_json LIKE ${f} ESCAPE '\\' OR representative_product LIKE ${f} ESCAPE '\\'
        OR representative_offer_title LIKE ${f} ESCAPE '\\')`
    })
    const matchSql = `${SCRAPABLE_SQL} AND (${tokenClauses.join(' OR ')})`

    const totalMatching = (
      this.db.prepare(`SELECT COUNT(*) AS c FROM merchants WHERE ${matchSql}`).get(params) as {
        c: number
      }
    ).c

    const rows = this.db
      .prepare(
        `SELECT id, name FROM merchants
         WHERE ${matchSql} AND ${NEEDS_SYNC_SQL}
         ORDER BY offer_count DESC
         LIMIT 30`
      )
      .all(params) as { id: string; name: string }[]

    return {
      merchantIds: rows.map((r) => r.id),
      totalMatching,
      sample: rows.slice(0, 5).map((r) => r.name)
    }
  }

  upsertMany(rows: NormalizedMerchantRow[]): number {
    const tx = this.db.transaction((items: NormalizedMerchantRow[]) => {
      for (const row of items) {
        const { _shopRefDerived, ...rest } = row
        this.upsertStmt.run({
          ...rest,
          shop_ref_derived: _shopRefDerived ? 1 : 0
        })
      }
      return items.length
    })
    return tx(rows)
  }

  /**
   * Drop merchants with no openable external link (both shop_url and entry_url empty).
   * Also removes merchant favorites / recent_views for those ids.
   */
  deleteWithoutExternalLinks(): number {
    const noLink = `(shop_url IS NULL OR shop_url = '') AND (entry_url IS NULL OR entry_url = '')`
    const idSub = `SELECT id FROM merchants WHERE ${noLink}`
    const run = this.db.transaction(() => {
      this.db
        .prepare(
          `DELETE FROM favorites WHERE target_type = 'merchant' AND target_id IN (${idSub})`
        )
        .run()
      this.db
        .prepare(
          `DELETE FROM recent_views WHERE target_type = 'merchant' AND target_id IN (${idSub})`
        )
        .run()
      const info = this.db.prepare(`DELETE FROM merchants WHERE ${noLink}`).run()
      return info.changes
    })
    return run()
  }

  list(query: MerchantListQuery): { rows: Merchant[]; total: number } {
    const where: string[] = []
    const params: Record<string, unknown> = {}

    if (query.q?.trim()) {
      where.push(`(name LIKE @q OR store_name LIKE @q OR host LIKE @q)`)
      params.q = `%${query.q.trim()}%`
    }
    if (query.host?.trim()) {
      where.push(`host = @host`)
      params.host = query.host.trim()
    }
    if (query.health?.length) {
      const parts: string[] = []
      query.health.forEach((h, i) => {
        if (h === 'n/a') {
          parts.push(`NOT ${SCRAPABLE_SQL}`)
        } else if (h === 'never') {
          parts.push(
            `(${SCRAPABLE_SQL} AND (app_health_status IS NULL OR app_health_status = '' OR app_health_status = 'never'))`
          )
        } else {
          const key = `h${i}`
          params[key] = h
          parts.push(`app_health_status = @${key}`)
        }
      })
      if (parts.length) where.push(`(${parts.join(' OR ')})`)
    }
    if (query.platforms?.length) {
      const parts = query.platforms.map((p, i) => {
        const key = `p${i}`
        params[key] = `%"${p}"%`
        return `platforms_json LIKE @${key}`
      })
      where.push(`(${parts.join(' OR ')})`)
    }
    if (query.shopPlatforms?.length) {
      const wantOther = query.shopPlatforms.includes(SHOP_PLATFORM_OTHER)
      const explicit = query.shopPlatforms.filter((p) => p !== SHOP_PLATFORM_OTHER)
      const parts: string[] = []
      if (explicit.length) {
        const keys = explicit.map((p, i) => {
          const key = `sp${i}`
          params[key] = p
          return `@${key}`
        })
        parts.push(`shop_platform IN (${keys.join(',')})`)
      }
      if (wantOther) {
        // Align with mapRow dual-fill: ldxp_token without shop_platform counts as ldxp, not other.
        const known = knownShopPlatformIds()
        if (known.length) {
          const keys = known.map((id, i) => {
            const key = `spk${i}`
            params[key] = id
            return `@${key}`
          })
          parts.push(
            `(
              (shop_platform IS NOT NULL AND shop_platform != '' AND shop_platform NOT IN (${keys.join(',')}))
              OR (
                (shop_platform IS NULL OR shop_platform = '')
                AND (ldxp_token IS NULL OR ldxp_token = '')
              )
            )`
          )
        } else {
          parts.push(`(shop_platform IS NULL OR shop_platform = '') AND (ldxp_token IS NULL OR ldxp_token = '')`)
        }
      }
      if (parts.length) where.push(`(${parts.join(' OR ')})`)
    }
    if (query.scrapableOnly || query.ldxpOnly) {
      where.push(SCRAPABLE_SQL)
    }
    if (query.withoutShopProducts) {
      where.push(
        `(${SCRAPABLE_SQL} AND NOT EXISTS (
           SELECT 1 FROM shop_products sp WHERE sp.merchant_id = merchants.id
         ))`
      )
    }

    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : ''
    const totalRow = this.db
      .prepare(`SELECT COUNT(*) AS c FROM merchants ${whereSql}`)
      .get(params) as { c: number }

    const sortMap: Record<string, string> = {
      name: 'name',
      price: 'representative_price',
      inStock: 'in_stock_count',
      offerCount: 'offer_count',
      updated: 'fetched_at'
    }
    const sortCol = sortMap[query.sort ?? 'name'] ?? 'name'
    const sortDir = query.sortDir === 'desc' ? 'DESC' : 'ASC'
    const limit = Math.max(1, Math.min(query.limit || 50, 500))
    const offset = Math.max(0, query.offset || 0)

    const rows = this.db
      .prepare(
        `SELECT merchants.*, ${LOCAL_COUNT_COL} FROM merchants ${whereSql}
         ORDER BY ${sortCol} ${sortDir}
         LIMIT @limit OFFSET @offset`
      )
      .all({ ...params, limit, offset }) as MerchantRow[]

    return { rows: rows.map(mapRow), total: totalRow.c }
  }
}
