import type Database from 'better-sqlite3'
import {
  collapseMerchantBatch,
  merchantIdentityKeys,
  mergeNormalizedMerchantRows,
  preferMerchantId
} from '@shared/lib/merchant-identity'
import { likeContains, tokenizeQuery } from '@shared/lib/search-query'
import { knownShopPlatformIds, SHOP_PLATFORM_OTHER } from '@shared/platforms/shop-profiles'
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

/** 屏蔽商家不进列表 / 候选 / 同步池（搜索另有独立过滤） */
const NOT_BLOCKED_SQL = `NOT EXISTS (
  SELECT 1 FROM blocked_targets b
  WHERE b.target_type = 'merchant' AND b.target_id = merchants.id
)`

/** 新鲜 = 最近一次刮取成功且在新鲜期内 */
const NEEDS_SYNC_SQL = `
  ${SCRAPABLE_SQL}
  AND ${NOT_BLOCKED_SQL}
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
    status: 'healthy' | 'failing' | 'retrying' | 'never',
    message?: string | null
  ): void {
    if (status === 'healthy') {
      this.db
        .prepare(
          `UPDATE merchants
           SET app_health_status = ?, app_health_at = ?, app_health_message = ?
           WHERE id = ?`
        )
        .run(status, new Date().toISOString(), message ?? null, merchantId)
      return
    }
    this.db
      .prepare(
        `UPDATE merchants
         SET app_health_status = ?, app_health_message = ?
         WHERE id = ?`
      )
      .run(status, message ?? null, merchantId)
  }

  setAppHealthByShopRef(
    platform: string,
    token: string,
    status: 'healthy' | 'failing' | 'retrying' | 'never',
    message?: string | null
  ): void {
    if (status === 'healthy') {
      this.db
        .prepare(
          `UPDATE merchants
           SET app_health_status = ?, app_health_at = ?, app_health_message = ?
           WHERE shop_platform = ? AND shop_token = ?`
        )
        .run(status, new Date().toISOString(), message ?? null, platform, token)
      return
    }
    this.db
      .prepare(
        `UPDATE merchants
         SET app_health_status = ?, app_health_message = ?
         WHERE shop_platform = ? AND shop_token = ?`
      )
      .run(status, message ?? null, platform, token)
  }

  /** Write confirmed host-token shop ref after fingerprint probe. */
  setShopRef(merchantId: string, platform: string, token: string): void {
    this.db
      .prepare(
        `UPDATE merchants
         SET shop_platform = ?, shop_token = ?
         WHERE id = ?`
      )
      .run(platform, token, merchantId)
  }

  /**
   * Drop scrapable ref when live fingerprint proves wrong family
   * (keeps collector_kind for UI soft label).
   */
  clearShopRef(merchantId: string): void {
    this.db
      .prepare(
        `UPDATE merchants
         SET shop_platform = NULL, shop_token = NULL,
             app_health_status = 'never',
             app_health_at = ?,
             app_health_message = ?
         WHERE id = ?`
      )
      .run(new Date().toISOString(), '指纹不符，已取消平台标记', merchantId)
  }

  /** kami/yiciyuan candidates without confirmed scrapable ref — for live probe. */
  listYiciyuanProbeCandidates(limit = 40): {
    id: string
    host: string
    shopUrl: string | null
    entryUrl: string | null
  }[] {
    const rows = this.db
      .prepare(
        `SELECT id, host, shop_url AS shopUrl, entry_url AS entryUrl
         FROM merchants
         WHERE collector_kind IN ('kami', 'yiciyuan')
           AND host IS NOT NULL AND trim(host) != ''
           AND (shop_platform IS NULL OR shop_platform = '' OR shop_platform = 'kami')
         ORDER BY offer_count DESC
         LIMIT ?`
      )
      .all(Math.max(1, Math.min(limit, 100))) as {
      id: string
      host: string
      shopUrl: string | null
      entryUrl: string | null
    }[]
    return rows
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
           WHERE ${SCRAPABLE_SQL} AND ${NOT_BLOCKED_SQL}
           ORDER BY name ASC`
        )
        .all() as { id: string; name: string; shopPlatform: string; shopToken: string }[]
    ).map((r) => ({
      ...r,
      ldxpToken: r.shopPlatform === 'ldxp' ? r.shopToken : r.shopToken
    }))
  }

  countScrapable(): number {
    return (
      this.db
        .prepare(`SELECT COUNT(*) AS c FROM merchants WHERE ${SCRAPABLE_SQL} AND ${NOT_BLOCKED_SQL}`)
        .get() as {
        c: number
      }
    ).c
  }

  count(): number {
    const row = this.db
      .prepare(`SELECT COUNT(*) AS c FROM merchants WHERE ${NOT_BLOCKED_SQL}`)
      .get() as {
      c: number
    }
    return row.c
  }

  isMerchantBlocked(id: string): boolean {
    const row = this.db
      .prepare(
        `SELECT 1 AS ok FROM blocked_targets
         WHERE target_type = 'merchant' AND target_id = ?
         LIMIT 1`
      )
      .get(id) as { ok: number } | undefined
    return !!row
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
    /**
     * 后台自动刷新：排除已失败店，避免反复抽到；用户主动同步成功(healthy)后才重新入池。
     */
    excludeFailing?: boolean
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
    const failingFilter = opts.excludeFailing
      ? ` AND COALESCE(app_health_status, '') != 'failing'`
      : ''
    return (
      this.db
        .prepare(
          `SELECT id, name, shop_platform AS shopPlatform, shop_token AS shopToken FROM merchants
           WHERE ${NEEDS_SYNC_SQL}${platformFilter}${failingFilter}
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
    const matchSql = `${SCRAPABLE_SQL} AND ${NOT_BLOCKED_SQL} AND (${tokenClauses.join(' OR ')})`

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

  /**
   * Upsert merchants with cross-source identity dedupe:
   * same shop_platform+shop_token or same normalized shop/entry URL → one row.
   * When a match already exists, reuse that id (favorites / local health stay put).
   */
  upsertMany(rows: NormalizedMerchantRow[]): number {
    if (!rows.length) return 0
    const tx = this.db.transaction((items: NormalizedMerchantRow[]) => {
      // Clean historical dups first so identity map is 1:1.
      this.dedupeExistingInTx()

      const collapsed = collapseMerchantBatch(items)
      const keyToId = this.buildIdentityIndex()

      for (const row of collapsed) {
        const keys = merchantIdentityKeys(row)
        const matchedIds = new Set<string>()
        for (const key of keys) {
          const existingId = keyToId.get(key)
          if (existingId) matchedIds.add(existingId)
        }

        let targetId = row.id
        if (matchedIds.size > 1) {
          let winner = [...matchedIds][0]!
          for (const id of matchedIds) winner = preferMerchantId(winner, id)
          for (const id of matchedIds) {
            if (id !== winner) this.mergeMerchantIdsInTx(id, winner)
          }
          targetId = winner
        } else if (matchedIds.size === 1) {
          // Always keep the already-stored id (stable favorites / app health).
          targetId = [...matchedIds][0]!
        }

        // Same-id refresh: take incoming catalog as-is.
        // Cross-id identity hit: merge so a weaker second source does not wipe richer fields.
        let toWrite: NormalizedMerchantRow
        if (targetId === row.id) {
          toWrite = row
        } else {
          const existing = this.loadNormalizedById(targetId)
          const incoming = { ...row, id: targetId }
          toWrite = existing
            ? mergeNormalizedMerchantRows(existing, incoming, targetId)
            : incoming
        }

        const { _shopRefDerived, ...rest } = toWrite
        this.upsertStmt.run({
          ...rest,
          shop_ref_derived: _shopRefDerived ? 1 : 0
        })

        for (const key of merchantIdentityKeys(toWrite)) {
          keyToId.set(key, toWrite.id)
        }
      }

      this.dedupeExistingInTx()
      return collapsed.length
    })
    return tx(rows)
  }

  /** Merge merchants that already share shop ref or normalized URL. Returns deleted count. */
  dedupeExisting(): number {
    return this.db.transaction(() => this.dedupeExistingInTx())()
  }

  /** Load a stored merchant as NormalizedMerchantRow for identity merge. */
  private loadNormalizedById(id: string): NormalizedMerchantRow | null {
    const r = this.db
      .prepare(
        `SELECT id, name, store_name, host, shop_url, entry_url,
                source_id, source_name, collector_kind, health_status,
                offer_count, in_stock_count, out_of_stock_count, product_count, platform_count,
                platforms_json, product_types_json,
                representative_product, representative_offer_title, representative_price,
                representative_currency, lowest_hit_count, warranty_lowest_hit_count,
                risk_feedback_count, has_platform_aftersales,
                shop_created_at, included_at, last_success_at, latest_seen_at,
                consecutive_failures, observation_started_at, generated_at, fetched_at,
                raw_json, ldxp_token, shop_platform, shop_token, name_norm
         FROM merchants WHERE id = ?`
      )
      .get(id) as
      | {
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
          raw_json: string | null
          ldxp_token: string | null
          shop_platform: string | null
          shop_token: string | null
          name_norm: string | null
        }
      | undefined
    if (!r) return null
    return {
      id: r.id,
      name: r.name,
      store_name: r.store_name,
      host: r.host,
      shop_url: r.shop_url,
      entry_url: r.entry_url,
      source_id: r.source_id,
      source_name: r.source_name,
      collector_kind: r.collector_kind,
      health_status: r.health_status,
      offer_count: r.offer_count,
      in_stock_count: r.in_stock_count,
      out_of_stock_count: r.out_of_stock_count,
      product_count: r.product_count,
      platform_count: r.platform_count,
      platforms_json: r.platforms_json || '[]',
      product_types_json: r.product_types_json || '[]',
      representative_product: r.representative_product,
      representative_offer_title: r.representative_offer_title,
      representative_price: r.representative_price,
      representative_currency: r.representative_currency,
      lowest_hit_count: r.lowest_hit_count,
      warranty_lowest_hit_count: r.warranty_lowest_hit_count,
      risk_feedback_count: r.risk_feedback_count,
      has_platform_aftersales: r.has_platform_aftersales,
      shop_created_at: r.shop_created_at,
      included_at: r.included_at,
      last_success_at: r.last_success_at,
      latest_seen_at: r.latest_seen_at,
      consecutive_failures: r.consecutive_failures,
      observation_started_at: r.observation_started_at,
      generated_at: r.generated_at,
      fetched_at: r.fetched_at,
      raw_json: r.raw_json ?? '{}',
      ldxp_token: r.ldxp_token,
      shop_platform: r.shop_platform,
      shop_token: r.shop_token,
      name_norm: r.name_norm ?? r.name.toLowerCase(),
      _shopRefDerived: !!(r.shop_platform && r.shop_token)
    }
  }

  private buildIdentityIndex(): Map<string, string> {
    const map = new Map<string, string>()
    const rows = this.db
      .prepare(
        `SELECT id, shop_platform, shop_token, shop_url, entry_url, offer_count
         FROM merchants`
      )
      .all() as {
      id: string
      shop_platform: string | null
      shop_token: string | null
      shop_url: string | null
      entry_url: string | null
      offer_count: number
    }[]

    for (const r of rows) {
      for (const key of merchantIdentityKeys(r)) {
        const prev = map.get(key)
        if (!prev) {
          map.set(key, r.id)
          continue
        }
        // Ambiguous existing index: keep preferred id (dedupe will merge the other).
        map.set(key, preferMerchantId(prev, r.id))
      }
    }
    return map
  }

  private dedupeExistingInTx(): number {
    let deleted = 0
    // Iterate until stable (transitive URL/ref links).
    for (let pass = 0; pass < 8; pass += 1) {
      const index = new Map<string, string>()
      const rows = this.db
        .prepare(
          `SELECT id, shop_platform, shop_token, shop_url, entry_url
           FROM merchants`
        )
        .all() as {
        id: string
        shop_platform: string | null
        shop_token: string | null
        shop_url: string | null
        entry_url: string | null
      }[]

      let mergedThisPass = 0
      for (const r of rows) {
        // Skip if already deleted this pass.
        const still = this.db.prepare(`SELECT 1 AS ok FROM merchants WHERE id = ?`).get(r.id) as
          | { ok: number }
          | undefined
        if (!still) continue

        for (const key of merchantIdentityKeys(r)) {
          const existing = index.get(key)
          if (!existing) {
            index.set(key, r.id)
            continue
          }
          if (existing === r.id) continue
          const winner = preferMerchantId(existing, r.id)
          const loser = winner === existing ? r.id : existing
          if (this.mergeMerchantIdsInTx(loser, winner)) {
            deleted += 1
            mergedThisPass += 1
            index.set(key, winner)
            // Rebind other keys of loser that pointed elsewhere — rebuild next pass.
          }
        }
      }
      if (mergedThisPass === 0) break
    }
    return deleted
  }

  /**
   * Move FK refs from loser → winner and delete loser.
   * Returns true if loser was removed.
   */
  private mergeMerchantIdsInTx(loserId: string, winnerId: string): boolean {
    if (loserId === winnerId) return false
    const loser = this.db.prepare(`SELECT id FROM merchants WHERE id = ?`).get(loserId) as
      | { id: string }
      | undefined
    const winner = this.db.prepare(`SELECT id FROM merchants WHERE id = ?`).get(winnerId) as
      | { id: string }
      | undefined
    if (!loser || !winner) return false

    // Copy richer catalog fields onto winner when loser is better filled.
    const both = this.db
      .prepare(
        `SELECT id, name, store_name, host, shop_url, entry_url, source_id, source_name,
                collector_kind, health_status, offer_count, in_stock_count, out_of_stock_count,
                product_count, platform_count, platforms_json, product_types_json,
                representative_product, representative_offer_title, representative_price,
                representative_currency, shop_platform, shop_token, ldxp_token, name_norm
         FROM merchants WHERE id IN (?, ?)`
      )
      .all(loserId, winnerId) as Record<string, unknown>[]

    const w = both.find((r) => r.id === winnerId)
    const l = both.find((r) => r.id === loserId)
    if (w && l) {
      const pickStr = (a: unknown, b: unknown): string | null => {
        const as = typeof a === 'string' && a.trim() ? a.trim() : null
        const bs = typeof b === 'string' && b.trim() ? b.trim() : null
        return as ?? bs
      }
      const maxN = (a: unknown, b: unknown): number =>
        Math.max(typeof a === 'number' ? a : 0, typeof b === 'number' ? b : 0)

      this.db
        .prepare(
          `UPDATE merchants SET
             name = COALESCE(NULLIF(trim(name), ''), ?),
             store_name = COALESCE(store_name, ?),
             host = COALESCE(host, ?),
             shop_url = COALESCE(shop_url, ?),
             entry_url = COALESCE(entry_url, ?),
             source_name = CASE
               WHEN source_name IS NOT NULL AND source_name != '' AND ? IS NOT NULL AND ? != ''
                    AND instr(source_name, ?) = 0
               THEN source_name || ' · ' || ?
               WHEN source_name IS NULL OR source_name = '' THEN ?
               ELSE source_name
             END,
             collector_kind = COALESCE(collector_kind, ?),
             offer_count = MAX(offer_count, ?),
             in_stock_count = MAX(in_stock_count, ?),
             out_of_stock_count = MAX(out_of_stock_count, ?),
             product_count = MAX(product_count, ?),
             shop_platform = COALESCE(shop_platform, ?),
             shop_token = COALESCE(shop_token, ?),
             ldxp_token = COALESCE(ldxp_token, ?)
           WHERE id = ?`
        )
        .run(
          String(l.name ?? w.name),
          pickStr(l.store_name, null),
          pickStr(l.host, null),
          pickStr(l.shop_url, null),
          pickStr(l.entry_url, null),
          pickStr(l.source_name, null),
          pickStr(l.source_name, null),
          pickStr(l.source_name, null) ?? '',
          pickStr(l.source_name, null),
          pickStr(l.source_name, null),
          pickStr(l.collector_kind, null),
          maxN(l.offer_count, 0),
          maxN(l.in_stock_count, 0),
          maxN(l.out_of_stock_count, 0),
          maxN(l.product_count, 0),
          pickStr(l.shop_platform, null),
          pickStr(l.shop_token, null),
          pickStr(l.ldxp_token, null),
          winnerId
        )
    }

    // Favorites / recent / blocked: drop loser if winner already has the row.
    this.db
      .prepare(
        `DELETE FROM favorites
         WHERE target_type = 'merchant' AND target_id = ?
           AND EXISTS (
             SELECT 1 FROM favorites f2
             WHERE f2.target_type = 'merchant' AND f2.target_id = ?
           )`
      )
      .run(loserId, winnerId)
    this.db
      .prepare(
        `UPDATE favorites SET target_id = ?
         WHERE target_type = 'merchant' AND target_id = ?`
      )
      .run(winnerId, loserId)

    this.db
      .prepare(
        `DELETE FROM recent_views
         WHERE target_type = 'merchant' AND target_id = ?
           AND EXISTS (
             SELECT 1 FROM recent_views r2
             WHERE r2.target_type = 'merchant' AND r2.target_id = ?
           )`
      )
      .run(loserId, winnerId)
    this.db
      .prepare(
        `UPDATE recent_views SET target_id = ?
         WHERE target_type = 'merchant' AND target_id = ?`
      )
      .run(winnerId, loserId)

    this.db
      .prepare(
        `DELETE FROM blocked_targets
         WHERE target_type = 'merchant' AND target_id = ?
           AND EXISTS (
             SELECT 1 FROM blocked_targets b2
             WHERE b2.target_type = 'merchant' AND b2.target_id = ?
           )`
      )
      .run(loserId, winnerId)
    this.db
      .prepare(
        `UPDATE blocked_targets SET target_id = ?
         WHERE target_type = 'merchant' AND target_id = ?`
      )
      .run(winnerId, loserId)

    this.db
      .prepare(`UPDATE shop_products SET merchant_id = ? WHERE merchant_id = ?`)
      .run(winnerId, loserId)

    this.db.prepare(`DELETE FROM merchants WHERE id = ?`).run(loserId)
    return true
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
        .prepare(`DELETE FROM favorites WHERE target_type = 'merchant' AND target_id IN (${idSub})`)
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
    const where: string[] = [NOT_BLOCKED_SQL]
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
          // healthy / failing / retrying: only scrapable rows (match deriveAppHealthStatus)
          const key = `h${i}`
          params[key] = h
          parts.push(`(${SCRAPABLE_SQL} AND app_health_status = @${key})`)
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
        // shop_platform primary; host-token families also match PriceAI collector_kind before backfill
        const collectorOr: string[] = []
        if (explicit.includes('dujiao')) {
          collectorOr.push(`collector_kind = 'dujiao'`)
        }
        if (explicit.includes('yiciyuan')) {
          collectorOr.push(`collector_kind IN ('kami', 'yiciyuan')`)
        }
        if (collectorOr.length) {
          parts.push(`(shop_platform IN (${keys.join(',')}) OR ${collectorOr.join(' OR ')})`)
        } else {
          parts.push(`shop_platform IN (${keys.join(',')})`)
        }
      }
      if (wantOther) {
        // Align with mapRow dual-fill: ldxp_token without shop_platform counts as ldxp, not other.
        // Host-token families matched only via collector_kind (pre-backfill) are also not other.
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
                AND (
                  collector_kind IS NULL
                  OR collector_kind NOT IN ('dujiao', 'kami', 'yiciyuan')
                )
              )
            )`
          )
        } else {
          parts.push(
            `(shop_platform IS NULL OR shop_platform = '') AND (ldxp_token IS NULL OR ldxp_token = '')`
          )
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
