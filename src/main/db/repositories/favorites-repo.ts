import type Database from 'better-sqlite3'
import type { Favorite, FavoriteTargetType, RecentView } from '@shared/types/favorites'

export class FavoritesRepo {
  constructor(private readonly db: Database.Database) {}

  list(): Favorite[] {
    const rows = this.db
      .prepare(
        `SELECT f.id, f.target_type, f.target_id, f.note, f.created_at,
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
           ON f.target_type = 'shop_product' AND s.id = f.target_id
         ORDER BY f.created_at DESC`
      )
      .all() as {
      id: number
      target_type: string
      target_id: string
      note: string | null
      created_at: string
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
    }[]
    return rows.map((r) => {
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
    })
  }

  add(req: { targetType: FavoriteTargetType; targetId: string; note?: string }): Favorite {
    const createdAt = new Date().toISOString()
    this.db
      .prepare(
        `INSERT INTO favorites (target_type, target_id, note, created_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(target_type, target_id) DO UPDATE SET note = excluded.note`
      )
      .run(req.targetType, req.targetId, req.note ?? null, createdAt)
    const row = this.db
      .prepare(`SELECT * FROM favorites WHERE target_type = ? AND target_id = ?`)
      .get(req.targetType, req.targetId) as {
      id: number
      target_type: string
      target_id: string
      note: string | null
      created_at: string
    }
    return {
      id: row.id,
      targetType: row.target_type as FavoriteTargetType,
      targetId: row.target_id,
      note: row.note,
      createdAt: row.created_at
    }
  }

  remove(req: { targetType: FavoriteTargetType; targetId: string }): { ok: boolean } {
    const info = this.db
      .prepare(`DELETE FROM favorites WHERE target_type = ? AND target_id = ?`)
      .run(req.targetType, req.targetId)
    return { ok: info.changes > 0 }
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
