/**
 * SearchService — local SQLite only (K23).
 * Price source: shop_products (发卡网), NOT PriceAI offers.
 * Must NOT import HTTP clients or SyncOrchestrator.
 */
import type Database from 'better-sqlite3'
import { SEARCH_DEFAULTS } from '@shared/constants'
import type {
  FacetCounts,
  SearchHit,
  SearchMeta,
  SearchQuery,
  SearchResult
} from '@shared/types/search'
import type { CompareRequest, CompareResult } from '@shared/types/product'
import { nameNorm } from '@shared/lib/name-norm'
import { likeContains, tokenizeQuery } from '@shared/lib/search-query'

interface ShopSearchRow {
  id: string
  title: string
  shop_name: string | null
  merchant_id: string | null
  merchant_name: string | null
  merchant_health: string | null
  price: number | null
  currency: string | null
  stock: number | null
  source_url: string | null
  source: string
  source_goods_key: string
  source_shop_token: string
  goods_type: string | null
  category_name: string | null
  fetched_at: string | null
}

function contains(hay: string | null | undefined, needle: string): boolean {
  if (!hay || !needle) return false
  return nameNorm(hay).includes(nameNorm(needle))
}

function isInStock(stock?: number | null): boolean {
  return typeof stock === 'number' && stock > 0
}

/**
 * Rank a shop product row.
 * Phrase match still wins; multi-token queries score by title coverage
 * so "Claude 月卡" ranks "Claude Pro 月卡" above loose merchant-name hits.
 */
function scoreShop(row: ShopSearchRow, q: string, tokens: string[]): number {
  let score = 0
  const titleN = nameNorm(row.title)
  const qn = nameNorm(q)

  if (qn && titleN.includes(qn)) score += 40
  // Title starts with the phrase → strong intent match
  if (qn && titleN.startsWith(qn)) score += 10

  if (q && contains(row.shop_name ?? row.merchant_name, q)) score += 15
  if (q && contains(row.category_name, q)) score += 10

  let titleTokenHits = 0
  let otherTokenHits = 0
  for (const t of tokens) {
    if (!t) continue
    if (titleN.includes(t)) {
      titleTokenHits += 1
    } else if (
      contains(row.shop_name ?? row.merchant_name, t) ||
      contains(row.category_name, t) ||
      contains(row.goods_type, t)
    ) {
      otherTokenHits += 1
    }
  }
  // Prefer title token hits (design: +10/token cap 30)
  score += Math.min(30, titleTokenHits * 10)
  score += Math.min(10, otherTokenHits * 4)

  // Multi-token coverage: all title tokens >> partial
  if (tokens.length >= 2) {
    const coverage = titleTokenHits / tokens.length
    score += Math.round(coverage * 20)
    if (titleTokenHits === tokens.length) score += 15
  }

  if (isInStock(row.stock)) score += 15
  if (row.merchant_health === 'healthy') score += 10
  if (row.merchant_health === 'failing') score -= 20
  if (row.merchant_health === 'retrying') score -= 10
  return score
}

/** Shared SELECT for shop_products + merchant join. */
const SHOP_SELECT = `SELECT s.id, s.title, s.shop_name, s.merchant_id, m.name AS merchant_name,
                CASE
                  WHEN m.shop_token IS NULL OR m.shop_token = ''
                    OR m.shop_platform IS NULL OR m.shop_platform = '' THEN 'n/a'
                  WHEN m.app_health_status IS NULL OR m.app_health_status = '' THEN 'never'
                  ELSE m.app_health_status
                END AS merchant_health, s.price, s.currency, s.stock,
                s.source_url, s.source, s.source_goods_key, s.source_shop_token, s.goods_type,
                s.category_name, s.fetched_at
         FROM shop_products s
         LEFT JOIN merchants m ON m.id = s.merchant_id`

export class SearchService {
  constructor(private readonly db: Database.Database) {}

  meta(): SearchMeta {
    const shopProductsCount = (
      this.db.prepare(`SELECT COUNT(*) AS c FROM shop_products`).get() as { c: number }
    ).c
    return { shopProductsCount, readyForHero: shopProductsCount > 0 }
  }

  query(req: SearchQuery): SearchResult {
    const { shopProductsCount } = this.meta()
    if (shopProductsCount === 0) {
      return {
        hits: [],
        total: 0,
        emptyReason: 'SHOP_PRODUCTS_NOT_SYNCED',
        facets: {}
      }
    }

    const q = (req.q ?? '').trim()
    const tokens = tokenizeQuery(q)
    const limit = req.limit ?? SEARCH_DEFAULTS.limit
    const offset = req.offset ?? SEARCH_DEFAULTS.offset

    const { where, params } = this.buildWhere(req, q, tokens)
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : ''
    let rows = this.db
      .prepare(`${SHOP_SELECT} ${whereSql} LIMIT 3000`)
      .all(params) as ShopSearchRow[]

    // Soft fallback: multi-token AND empty → OR match (recall), score still ranks best first
    if (q && tokens.length >= 2 && rows.length === 0) {
      const or = this.buildTokenOrWhere(tokens)
      const orWhere = [...or.where]
      const orParams = { ...or.params }
      this.appendFilters(req, orWhere, orParams)
      const orSql = orWhere.length ? `WHERE ${orWhere.join(' AND ')}` : ''
      rows = this.db.prepare(`${SHOP_SELECT} ${orSql} LIMIT 3000`).all(orParams) as ShopSearchRow[]
    }

    const hits: SearchHit[] = rows.map((row) => ({
      kind: 'shop_product' as const,
      id: `shop:${row.id}`,
      title: row.title,
      subtitle: row.shop_name || row.merchant_name || undefined,
      merchantId: row.merchant_id,
      merchantName: row.merchant_name || row.shop_name,
      merchantHealth: row.merchant_health,
      price: row.price,
      currency: row.currency,
      status: isInStock(row.stock) ? 'in_stock' : null,
      stockCount: row.stock,
      productType: row.goods_type || row.category_name,
      sourceUrl: row.source_url,
      platformId: row.source,
      shopToken: row.source_shop_token,
      shopGoodsKey: row.source_goods_key,
      ldxpGoodsKey: row.source_goods_key,
      ldxpToken: row.source_shop_token,
      score: scoreShop(row, q, tokens),
      fetchedAt: row.fetched_at
    }))

    const sort = req.sort ?? 'score'
    const sortDir = req.sortDir ?? (sort === 'price' ? 'asc' : 'desc')
    hits.sort((a, b) => {
      if (sort === 'price') {
        const ap = a.price
        const bp = b.price
        if (ap == null && bp == null) return b.score - a.score
        if (ap == null) return 1
        if (bp == null) return -1
        const cmp = ap - bp
        return sortDir === 'asc' ? cmp : -cmp
      }
      const cmp = a.score - b.score
      if (cmp !== 0) return sortDir === 'asc' ? cmp : -cmp
      const ap = a.price
      const bp = b.price
      if (ap == null && bp == null) return 0
      if (ap == null) return 1
      if (bp == null) return -1
      return ap - bp
    })

    const facets = this.buildFacets(hits)
    const total = hits.length
    const page = hits.slice(offset, offset + limit)
    if (total === 0) {
      return { hits: [], total: 0, emptyReason: 'NO_MATCH', facets }
    }
    return { hits: page, total, facets }
  }

  compare(req: CompareRequest): CompareResult {
    const seed = nameNorm(req.titleNorm ?? '')
    const tokens = tokenizeQuery(seed)
    // Product-family probe: first 2 tokens (e.g. "claude pro") so 月卡/季卡 variants both surface.
    // Full-title AND would over-narrow and hide sibling SKUs across shops.
    const q =
      tokens.length >= 2 ? tokens.slice(0, 2).join(' ') : tokens[0] || (req.titleNorm ?? '').trim()

    const result = this.query({
      q,
      kinds: ['shop_product'],
      sort: 'price',
      sortDir: 'asc',
      limit: 300,
      offset: 0
    })

    const minHits = tokens.length <= 1 ? 1 : Math.min(2, tokens.length)
    const rows = result.hits
      .filter((h) => {
        const ht = nameNorm(h.title)
        if (!seed) return true
        if (ht === seed) return true
        if (seed.length >= 6 && (ht.includes(seed) || seed.includes(ht))) return true
        const hitCount = tokens.filter((t) => ht.includes(t)).length
        return hitCount >= minHits || (tokens.length > 0 && hitCount / tokens.length >= 0.5)
      })
      .slice(0, 100)

    return {
      mode: 'weak_title',
      product: null,
      rows,
      tokens,
      notice:
        '弱比价：按标题关键词聚合，非标准 SKU。同名规格/时长可能仍混在一起，请对照完整标题后再下单。'
    }
  }

  /**
   * Token AND: every token must appear in title/shop/merchant/category.
   * Falls back to full-string LIKE when tokenization yields nothing useful.
   */
  private buildWhere(
    req: SearchQuery,
    q: string,
    tokens: string[]
  ): { where: string[]; params: Record<string, unknown> } {
    const where: string[] = []
    const params: Record<string, unknown> = {}

    if (q) {
      if (tokens.length > 0) {
        const { where: tw, params: tp } = this.buildTokenAndWhere(tokens)
        where.push(...tw)
        Object.assign(params, tp)
      } else {
        where.push(
          `(s.title LIKE @q ESCAPE '\\' OR s.shop_name LIKE @q ESCAPE '\\' OR m.name LIKE @q ESCAPE '\\' OR s.category_name LIKE @q ESCAPE '\\')`
        )
        params.q = likeContains(q)
      }
    }

    this.appendFilters(req, where, params)
    return { where, params }
  }

  private buildTokenAndWhere(tokens: string[]): {
    where: string[]
    params: Record<string, unknown>
  } {
    const where: string[] = []
    const params: Record<string, unknown> = {}
    tokens.forEach((t, i) => {
      const key = `tok${i}`
      params[key] = likeContains(t)
      where.push(
        `(s.title LIKE @${key} ESCAPE '\\' OR s.shop_name LIKE @${key} ESCAPE '\\' OR m.name LIKE @${key} ESCAPE '\\' OR s.category_name LIKE @${key} ESCAPE '\\' OR s.goods_type LIKE @${key} ESCAPE '\\')`
      )
    })
    return { where, params }
  }

  private buildTokenOrWhere(tokens: string[]): {
    where: string[]
    params: Record<string, unknown>
  } {
    const params: Record<string, unknown> = {}
    const clauses = tokens.map((t, i) => {
      const key = `otok${i}`
      params[key] = likeContains(t)
      return `(s.title LIKE @${key} ESCAPE '\\' OR s.shop_name LIKE @${key} ESCAPE '\\' OR m.name LIKE @${key} ESCAPE '\\' OR s.category_name LIKE @${key} ESCAPE '\\' OR s.goods_type LIKE @${key} ESCAPE '\\')`
    })
    return {
      where: clauses.length ? [`(${clauses.join(' OR ')})`] : [],
      params
    }
  }

  private appendFilters(req: SearchQuery, where: string[], params: Record<string, unknown>): void {
    if (req.inStockOnly) {
      where.push(`(s.stock IS NOT NULL AND s.stock > 0)`)
    }
    if (req.priceMin != null) {
      where.push(`s.price >= @priceMin`)
      params.priceMin = req.priceMin
    }
    if (req.priceMax != null) {
      where.push(`s.price <= @priceMax`)
      params.priceMax = req.priceMax
    }
    if (req.merchantName?.trim()) {
      where.push(`(COALESCE(m.name, s.shop_name) = @merchantName)`)
      params.merchantName = req.merchantName.trim()
    }
    if (req.titleContains?.length) {
      req.titleContains.forEach((t, i) => {
        params[`tc${i}`] = likeContains(t)
        where.push(`s.title LIKE @tc${i} ESCAPE '\\'`)
      })
    }
  }

  private buildFacets(hits: SearchHit[]): FacetCounts {
    const merchants = new Map<string, number>()
    const productTypes = new Map<string, number>()
    for (const h of hits) {
      if (h.merchantName) merchants.set(h.merchantName, (merchants.get(h.merchantName) ?? 0) + 1)
      if (h.productType) productTypes.set(h.productType, (productTypes.get(h.productType) ?? 0) + 1)
    }
    const toBuckets = (m: Map<string, number>): { value: string; count: number }[] =>
      [...m.entries()]
        .map(([value, count]) => ({ value, count }))
        .sort((a, b) => b.count - a.count)
        .slice(0, 30)
    return {
      merchant: toBuckets(merchants),
      productType: toBuckets(productTypes)
    }
  }
}
