import type Database from 'better-sqlite3'
import { productTitleSearchFields } from '@shared/lib/search-query'
import type { ShopProduct, ShopProductListQuery } from '@shared/types/product'

export interface NormalizedShopProductRow {
  id: string
  source: string
  merchant_id: string | null
  source_shop_token: string
  source_goods_key: string
  source_url: string | null
  shop_name: string | null
  title: string
  price: number | null
  market_price: number | null
  currency: string | null
  goods_type: string | null
  category_id: number | null
  category_name: string | null
  stock: number | null
  image: string | null
  description_text: string | null
  description_html: string | null
  fetched_at: string
  raw_json: string
}

interface ShopRow extends NormalizedShopProductRow {
  title_norm?: string | null
  title_tokens?: string | null
}

type UpsertRow = NormalizedShopProductRow & {
  title_norm: string
  title_tokens: string
}

function withTitleSearchFields(row: NormalizedShopProductRow): UpsertRow {
  const f = productTitleSearchFields(row.title)
  return {
    ...row,
    title_norm: f.titleNorm,
    title_tokens: f.titleTokens
  }
}

function mapRow(row: ShopRow): ShopProduct {
  return {
    id: row.id,
    source: row.source,
    merchantId: row.merchant_id,
    sourceShopToken: row.source_shop_token,
    sourceGoodsKey: row.source_goods_key,
    sourceUrl: row.source_url,
    shopName: row.shop_name,
    title: row.title,
    price: row.price,
    marketPrice: row.market_price,
    currency: row.currency,
    goodsType: row.goods_type,
    categoryId: row.category_id,
    categoryName: row.category_name,
    stock: row.stock,
    image: row.image,
    descriptionText: row.description_text,
    fetchedAt: row.fetched_at
  }
}

const UPSERT = `
INSERT INTO shop_products (
  id, source, merchant_id, source_shop_token, source_goods_key, source_url, shop_name,
  title, title_norm, title_tokens, price, market_price, currency, goods_type, category_id, category_name,
  stock, image, description_text, description_html, fetched_at, raw_json
) VALUES (
  @id, @source, @merchant_id, @source_shop_token, @source_goods_key, @source_url, @shop_name,
  @title, @title_norm, @title_tokens, @price, @market_price, @currency, @goods_type, @category_id, @category_name,
  @stock, @image, @description_text, @description_html, @fetched_at, @raw_json
)
ON CONFLICT(source, source_shop_token, source_goods_key) DO UPDATE SET
  id = excluded.id,
  merchant_id = excluded.merchant_id,
  source_url = excluded.source_url,
  shop_name = excluded.shop_name,
  title = excluded.title,
  title_norm = excluded.title_norm,
  title_tokens = excluded.title_tokens,
  price = excluded.price,
  market_price = excluded.market_price,
  currency = excluded.currency,
  goods_type = excluded.goods_type,
  category_id = excluded.category_id,
  category_name = excluded.category_name,
  stock = excluded.stock,
  image = excluded.image,
  description_text = excluded.description_text,
  description_html = excluded.description_html,
  fetched_at = excluded.fetched_at,
  raw_json = excluded.raw_json
`

export class ShopProductsRepo {
  private readonly upsertStmt

  constructor(private readonly db: Database.Database) {
    this.upsertStmt = this.db.prepare(UPSERT)
  }

  count(): number {
    return (this.db.prepare(`SELECT COUNT(*) AS c FROM shop_products`).get() as { c: number }).c
  }

  upsertMany(rows: NormalizedShopProductRow[]): number {
    // Keep OOS / null stock so search can toggle "只看有货" offline.
    const keep = rows.map(withTitleSearchFields)
    const tx = this.db.transaction((items: UpsertRow[]) => {
      for (const r of items) this.upsertStmt.run(r)
      return items.length
    })
    return tx(keep)
  }

  /**
   * Full replace for one shop after successful scrape:
   * drop previous rows for (source, token), insert all scraped rows (including OOS).
   */
  replaceForShop(
    source: string,
    token: string,
    rows: NormalizedShopProductRow[]
  ): { deleted: number; inserted: number } {
    const keep = rows.map(withTitleSearchFields)
    const tx = this.db.transaction(() => {
      const del = this.db
        .prepare(`DELETE FROM shop_products WHERE source = ? AND source_shop_token = ?`)
        .run(source, token)
      for (const r of keep) this.upsertStmt.run(r)
      return { deleted: del.changes, inserted: keep.length }
    })
    return tx()
  }

  getById(id: string): ShopProduct | null {
    const row = this.db.prepare(`SELECT * FROM shop_products WHERE id = ?`).get(id) as ShopRow | undefined
    return row ? mapRow(row) : null
  }

  deleteById(id: string): boolean {
    const r = this.db.prepare(`DELETE FROM shop_products WHERE id = ?`).run(id)
    return r.changes > 0
  }

  list(query: ShopProductListQuery): { rows: ShopProduct[]; total: number } {
    const where: string[] = []
    const params: Record<string, unknown> = {}
    if (query.merchantId) {
      where.push(`merchant_id = @merchantId`)
      params.merchantId = query.merchantId
    }
    if (query.token) {
      where.push(`source_shop_token = @token`)
      params.token = query.token
    }
    if (query.q?.trim()) {
      where.push(`title LIKE @q`)
      params.q = `%${query.q.trim()}%`
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : ''
    const total = (
      this.db.prepare(`SELECT COUNT(*) AS c FROM shop_products ${whereSql}`).get(params) as {
        c: number
      }
    ).c
    const limit = Math.max(1, Math.min(query.limit || 50, 200))
    const offset = Math.max(0, query.offset || 0)
    const rows = this.db
      .prepare(
        `SELECT * FROM shop_products ${whereSql}
         ORDER BY price IS NULL, price ASC
         LIMIT @limit OFFSET @offset`
      )
      .all({ ...params, limit, offset }) as ShopRow[]
    return { rows: rows.map(mapRow), total }
  }
}
