import type Database from 'better-sqlite3'
import type {
  Favorite,
  FavoriteTargetType,
  FavoriteUpdateRequest,
  RecentView
} from '@shared/types/favorites'

type FavoriteRow = {
  id: number
  target_type: string
  target_id: string
  note: string | null
  created_at: string
  baseline_price: number | null
  target_price: number | null
  title_snapshot: string | null
  price: number | null
  currency: string | null
  stock: number | null
  source_url: string | null
  fetched_at: string | null
  product_source: string | null
  shop_token: string | null
  shop_merchant_id: string | null
  merchant_shop_platform: string | null
  merchant_shop_token: string | null
  merchant_ldxp_token: string | null
}

const FAVORITE_SELECT = `SELECT f.id, f.target_type, f.target_id, f.note, f.created_at,
                f.baseline_price, f.target_price,
                CASE
                  WHEN f.target_type = 'merchant' THEN m.name
                  WHEN f.target_type = 'shop_product' THEN s.title
                  ELSE NULL
                END AS title_snapshot,
                s.price, s.currency, s.stock, s.source_url, s.fetched_at,
                s.source AS product_source,
                s.source_shop_token AS shop_token, s.merchant_id AS shop_merchant_id,
                m.shop_platform AS merchant_shop_platform,
                m.shop_token AS merchant_shop_token,
                m.ldxp_token AS merchant_ldxp_token
         FROM favorites f
         LEFT JOIN merchants m
           ON f.target_type = 'merchant' AND m.id = f.target_id
         LEFT JOIN shop_products s
           ON f.target_type = 'shop_product' AND s.id = f.target_id`

function mapFavoriteRow(r: FavoriteRow): Favorite {
  const isMerchant = r.target_type === 'merchant'
  const platformId = isMerchant
    ? r.merchant_shop_platform || (r.merchant_ldxp_token ? 'ldxp' : null)
    : r.product_source
  const shopToken = isMerchant ? r.merchant_shop_token || r.merchant_ldxp_token : r.shop_token
  return {
    id: r.id,
    targetType: r.target_type as FavoriteTargetType,
    targetId: r.target_id,
    note: r.note,
    createdAt: r.created_at,
    baselinePrice: r.baseline_price,
    targetPrice: r.target_price,
    titleSnapshot: r.title_snapshot ?? undefined,
    price: r.price,
    currency: r.currency,
    stock: r.stock,
    sourceUrl: r.source_url,
    fetchedAt: r.fetched_at,
    merchantId: isMerchant ? r.target_id : r.shop_merchant_id,
    platformId,
    shopToken,
    ldxpToken: shopToken
  }
}

export class FavoritesRepo {
  constructor(private readonly db: Database.Database) {}

  list(): Favorite[] {
    const rows = this.db
      .prepare(`${FAVORITE_SELECT} ORDER BY f.created_at DESC`)
      .all() as FavoriteRow[]
    return rows.map(mapFavoriteRow)
  }

  add(req: {
    targetType: FavoriteTargetType
    targetId: string
    note?: string
    targetPrice?: number | null
  }): Favorite {
    const createdAt = new Date().toISOString()
    let baseline: number | null = null
    if (req.targetType === 'shop_product') {
      const row = this.db
        .prepare(`SELECT price FROM shop_products WHERE id = ?`)
        .get(req.targetId) as { price: number | null } | undefined
      baseline = row?.price ?? null
    }
    this.db
      .prepare(
        `INSERT INTO favorites (target_type, target_id, note, created_at, baseline_price, target_price)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(target_type, target_id) DO UPDATE SET
           note = COALESCE(excluded.note, favorites.note),
           baseline_price = COALESCE(favorites.baseline_price, excluded.baseline_price),
           target_price = COALESCE(excluded.target_price, favorites.target_price)`
      )
      .run(
        req.targetType,
        req.targetId,
        req.note ?? null,
        createdAt,
        baseline,
        req.targetPrice ?? null
      )
    return this.getOne(req.targetType, req.targetId)!
  }

  update(req: FavoriteUpdateRequest): Favorite | null {
    const existing = this.db
      .prepare(`SELECT id FROM favorites WHERE target_type = ? AND target_id = ?`)
      .get(req.targetType, req.targetId) as { id: number } | undefined
    if (!existing) return null

    const sets: string[] = []
    const params: unknown[] = []
    if (req.note !== undefined) {
      sets.push('note = ?')
      params.push(req.note)
    }
    if (req.targetPrice !== undefined) {
      sets.push('target_price = ?')
      params.push(req.targetPrice)
    }
    if (sets.length) {
      params.push(req.targetType, req.targetId)
      this.db
        .prepare(`UPDATE favorites SET ${sets.join(', ')} WHERE target_type = ? AND target_id = ?`)
        .run(...params)
    }
    return this.getOne(req.targetType, req.targetId)
  }

  remove(req: { targetType: FavoriteTargetType; targetId: string }): { ok: boolean } {
    const info = this.db
      .prepare(`DELETE FROM favorites WHERE target_type = ? AND target_id = ?`)
      .run(req.targetType, req.targetId)
    return { ok: info.changes > 0 }
  }

  private getOne(targetType: FavoriteTargetType, targetId: string): Favorite | null {
    const row = this.db
      .prepare(`${FAVORITE_SELECT} WHERE f.target_type = ? AND f.target_id = ? LIMIT 1`)
      .get(targetType, targetId) as FavoriteRow | undefined
    return row ? mapFavoriteRow(row) : null
  }
}

export class RecentViewsRepo {
  constructor(private readonly db: Database.Database) {}

  list(limit = 30): RecentView[] {
    const rows = this.db
      .prepare(
        `SELECT target_type, target_id, title_snapshot, viewed_at
         FROM recent_views ORDER BY viewed_at DESC LIMIT ?`
      )
      .all(limit) as {
      target_type: string
      target_id: string
      title_snapshot: string | null
      viewed_at: string
    }[]
    return rows.map((r) => ({
      targetType: r.target_type,
      targetId: r.target_id,
      titleSnapshot: r.title_snapshot,
      viewedAt: r.viewed_at
    }))
  }

  touch(req: { targetType: string; targetId: string; titleSnapshot?: string }): { ok: boolean } {
    const viewedAt = new Date().toISOString()
    this.db
      .prepare(
        `INSERT INTO recent_views (target_type, target_id, title_snapshot, viewed_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(target_type, target_id) DO UPDATE SET
           viewed_at = excluded.viewed_at,
           title_snapshot = COALESCE(excluded.title_snapshot, recent_views.title_snapshot)`
      )
      .run(req.targetType, req.targetId, req.titleSnapshot ?? null, viewedAt)

    const count = (this.db.prepare(`SELECT COUNT(*) AS c FROM recent_views`).get() as { c: number })
      .c
    if (count > 100) {
      this.db
        .prepare(
          `DELETE FROM recent_views WHERE id IN (
             SELECT id FROM recent_views ORDER BY viewed_at ASC LIMIT ?
           )`
        )
        .run(count - 100)
    }
    return { ok: true }
  }
}
