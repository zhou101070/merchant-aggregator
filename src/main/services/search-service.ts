/**
 * SearchService — local SQLite only (K23).
 * Price source: shop_products (发卡网), NOT PriceAI offers.
 * Must NOT import HTTP clients or SyncOrchestrator.
 *
 * Ranking: synonym-aware recall + field-weighted text score (IDF / phrase /
 * order / adjacency) + light business boosts (stock / health / freshness).
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
import {
  compareRelevance,
  computeIdfFromRows,
  expandTokenGroups,
  isInStock,
  scoreShopRank,
  type RankContext
} from '@shared/lib/search-rank'
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

function rowToRank(row: ShopSearchRow): Parameters<typeof scoreShopRank>[0] {
  return {
    title: row.title,
    shopName: row.shop_name,
    merchantName: row.merchant_name,
    categoryName: row.category_name,
    goodsType: row.goods_type,
    stock: row.stock,
    merchantHealth: row.merchant_health,
    fetchedAt: row.fetched_at,
    price: row.price
  }
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
    const tokenGroups = expandTokenGroups(tokens)
    const limit = Math.max(1, req.limit ?? SEARCH_DEFAULTS.limit)
    const offset = Math.max(0, req.offset ?? SEARCH_DEFAULTS.offset)
    const sort = req.sort ?? 'score'
    const sortDir = req.sortDir ?? (sort === 'price' ? 'asc' : 'desc')

    let { where, params } = this.buildWhere(req, q, tokenGroups)
    let whereSql = where.length ? `WHERE ${where.join(' AND ')}` : ''

    // Soft fallback: multi-token AND empty → OR match (recall)
    if (q && tokenGroups.length >= 2) {
      const andTotal = this.countWhere(whereSql, params)
      if (andTotal === 0) {
        const or = this.buildTokenOrWhere(tokenGroups)
        const orWhere = [...or.where]
        const orParams = { ...or.params }
        this.appendFilters(req, orWhere, orParams)
        where = orWhere
        params = orParams
        whereSql = where.length ? `WHERE ${where.join(' AND ')}` : ''
      }
    }

    const total = this.countWhere(whereSql, params)
    if (total === 0) {
      return { hits: [], total: 0, emptyReason: 'NO_MATCH', facets: {} }
    }

    // No free-text query: SQL page over full match set (no 3000 cap).
    // With free-text: score in memory over all matches (usually << catalog size).
    if (!q) {
      const rankCtx: RankContext = {
        q,
        tokens,
        tokenGroups,
        idf: new Map(),
        nowMs: Date.now()
      }
      const orderSql = this.browseOrderSql(sort, sortDir)
      const pageParams = { ...params, limit, offset }
      const rows = this.db
        .prepare(`${SHOP_SELECT} ${whereSql} ${orderSql} LIMIT @limit OFFSET @offset`)
        .all(pageParams) as ShopSearchRow[]
      const hits = rows.map((row) => this.toHit(row, rankCtx))
      const facets = this.buildFacetsSql(whereSql, params)
      return { hits, total, facets }
    }

    const rows = this.db.prepare(`${SHOP_SELECT} ${whereSql}`).all(params) as ShopSearchRow[]
    // IDF from candidate set only — no per-token full-table COUNT
    const rankCtx: RankContext = {
      q,
      tokens,
      tokenGroups,
      idf: computeIdfFromRows(
        rows.map((row) => rowToRank(row)),
        tokens,
        tokenGroups
      ),
      nowMs: Date.now()
    }
    const hits = rows.map((row) => this.toHit(row, rankCtx))
    this.sortHits(hits, sort, sortDir)
    const facets = this.buildFacets(hits)
    return { hits: hits.slice(offset, offset + limit), total, facets }
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
   * Token AND: every synonym-group must hit title/shop/merchant/category/type
   * (OR within a group). Falls back to full-string LIKE when no tokens.
   */
  private buildWhere(
    req: SearchQuery,
    q: string,
    tokenGroups: string[][]
  ): { where: string[]; params: Record<string, unknown> } {
    const where: string[] = []
    const params: Record<string, unknown> = {}

    if (q) {
      if (tokenGroups.length > 0) {
        const { where: tw, params: tp } = this.buildTokenAndWhere(tokenGroups)
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

  private fieldMatchClause(paramKey: string): string {
    return `(s.title LIKE @${paramKey} ESCAPE '\\' OR s.shop_name LIKE @${paramKey} ESCAPE '\\' OR m.name LIKE @${paramKey} ESCAPE '\\' OR s.category_name LIKE @${paramKey} ESCAPE '\\' OR s.goods_type LIKE @${paramKey} ESCAPE '\\')`
  }

  private buildTokenAndWhere(tokenGroups: string[][]): {
    where: string[]
    params: Record<string, unknown>
  } {
    const where: string[] = []
    const params: Record<string, unknown> = {}
    tokenGroups.forEach((group, i) => {
      const ors = group.map((v, j) => {
        const key = `tok${i}_${j}`
        params[key] = likeContains(v)
        return this.fieldMatchClause(key)
      })
      where.push(`(${ors.join(' OR ')})`)
    })
    return { where, params }
  }

  private buildTokenOrWhere(tokenGroups: string[][]): {
    where: string[]
    params: Record<string, unknown>
  } {
    const params: Record<string, unknown> = {}
    const clauses: string[] = []
    tokenGroups.forEach((group, i) => {
      const ors = group.map((v, j) => {
        const key = `otok${i}_${j}`
        params[key] = likeContains(v)
        return this.fieldMatchClause(key)
      })
      clauses.push(`(${ors.join(' OR ')})`)
    })
    return {
      where: clauses.length ? [`(${clauses.join(' OR ')})`] : [],
      params
    }
  }

  private appendFilters(req: SearchQuery, where: string[], params: Record<string, unknown>): void {
    // 首页搜索屏蔽 ≤ hidePriceAtOrBelow 的占位/垃圾价、≥ hidePriceAtOrAbove 的异常高价(null 保留)
    where.push(
      `(s.price IS NULL OR (s.price > @hidePriceAtOrBelow AND s.price < @hidePriceAtOrAbove))`
    )
    params.hidePriceAtOrBelow = SEARCH_DEFAULTS.hidePriceAtOrBelow
    params.hidePriceAtOrAbove = SEARCH_DEFAULTS.hidePriceAtOrAbove
    // 本机黑名单：商品 id / 商家 id（搜索与比价共用 query 路径）
    where.push(
      `NOT EXISTS (
         SELECT 1 FROM blocked_targets b
         WHERE (b.target_type = 'shop_product' AND b.target_id = s.id)
            OR (b.target_type = 'merchant' AND b.target_id = s.merchant_id)
       )`
    )
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
      // Substring match, but drop titles that explicitly negate the term
      // (e.g. Plus chip must not hit 「非PLUS」「不含plus」).
      const negPrefixes = ['非', '不含', '无', '不带', '不是'] as const
      req.titleContains.forEach((t, i) => {
        const term = t.trim()
        if (!term) return
        params[`tc${i}`] = likeContains(term)
        where.push(`s.title LIKE @tc${i} ESCAPE '\\'`)
        negPrefixes.forEach((p, j) => {
          const glued = `tcn${i}_${j}`
          const spaced = `tcns${i}_${j}`
          params[glued] = likeContains(`${p}${term}`)
          params[spaced] = likeContains(`${p} ${term}`)
          where.push(`s.title NOT LIKE @${glued} ESCAPE '\\'`)
          where.push(`s.title NOT LIKE @${spaced} ESCAPE '\\'`)
        })
      })
    }
    if (req.titleExcludes?.length) {
      req.titleExcludes.forEach((t, i) => {
        const term = t.trim()
        if (!term) return
        params[`tex${i}`] = likeContains(term)
        where.push(`s.title NOT LIKE @tex${i} ESCAPE '\\'`)
      })
    }
  }

  private countWhere(whereSql: string, params: Record<string, unknown>): number {
    return (
      this.db
        .prepare(
          `SELECT COUNT(*) AS c FROM shop_products s
           LEFT JOIN merchants m ON m.id = s.merchant_id
           ${whereSql}`
        )
        .get(params) as { c: number }
    ).c
  }

  /** Browse / filter-only ordering (no free-text relevance score). */
  private browseOrderSql(sort: string, sortDir: string): string {
    const dir = sortDir === 'asc' ? 'ASC' : 'DESC'
    if (sort === 'price') {
      return `ORDER BY (s.price IS NULL) ASC, s.price ${dir}, s.id ASC`
    }
    if (sort === 'stock') {
      return `ORDER BY (s.stock IS NULL) ASC, s.stock ${dir}, s.id ASC`
    }
    if (sort === 'fetchedAt') {
      return `ORDER BY (s.fetched_at IS NULL) ASC, s.fetched_at ${dir}, s.id ASC`
    }
    if (sort === 'merchant') {
      return `ORDER BY (COALESCE(m.name, s.shop_name) IS NULL) ASC, COALESCE(m.name, s.shop_name) ${dir}, s.id ASC`
    }
    if (sort === 'title') {
      return `ORDER BY s.title ${dir}, s.id ASC`
    }
    // Default "score" browse: in-stock first, healthy shops, then cheaper
    return `ORDER BY
      (CASE WHEN s.stock IS NOT NULL AND s.stock > 0 THEN 0 ELSE 1 END) ASC,
      (CASE
         WHEN m.app_health_status = 'healthy' THEN 0
         WHEN m.app_health_status = 'failing' THEN 2
         WHEN m.app_health_status = 'retrying' THEN 1
         ELSE 1
       END) ASC,
      (s.price IS NULL) ASC,
      s.price ASC,
      s.id ASC`
  }

  private toHit(row: ShopSearchRow, rankCtx: RankContext): SearchHit {
    return {
      kind: 'shop_product',
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
      score: scoreShopRank(rowToRank(row), rankCtx),
      fetchedAt: row.fetched_at
    }
  }

  private sortHits(hits: SearchHit[], sort: string, sortDir: string): void {
    const mul = sortDir === 'asc' ? 1 : -1
    const nullsLast = (
      a: number | string | null | undefined,
      b: number | string | null | undefined
    ): number | null => {
      if (a == null && b == null) return 0
      if (a == null) return 1
      if (b == null) return -1
      return null
    }
    hits.sort((a, b) => {
      if (sort === 'price') {
        const n = nullsLast(a.price, b.price)
        if (n != null) return n === 0 ? compareRelevance(a, b) : n
        return mul * ((a.price as number) - (b.price as number)) || compareRelevance(a, b)
      }
      if (sort === 'stock') {
        const n = nullsLast(a.stockCount, b.stockCount)
        if (n != null) return n === 0 ? compareRelevance(a, b) : n
        return mul * ((a.stockCount as number) - (b.stockCount as number)) || compareRelevance(a, b)
      }
      if (sort === 'fetchedAt') {
        const n = nullsLast(a.fetchedAt, b.fetchedAt)
        if (n != null) return n === 0 ? compareRelevance(a, b) : n
        return (
          mul * String(a.fetchedAt).localeCompare(String(b.fetchedAt)) || compareRelevance(a, b)
        )
      }
      if (sort === 'merchant') {
        const am = a.merchantName ?? ''
        const bm = b.merchantName ?? ''
        if (!am && !bm) return compareRelevance(a, b)
        if (!am) return 1
        if (!bm) return -1
        const cmp = am.localeCompare(bm, 'zh-CN')
        return mul * cmp || compareRelevance(a, b)
      }
      if (sort === 'title') {
        const cmp = a.title.localeCompare(b.title, 'zh-CN')
        return mul * cmp || compareRelevance(a, b)
      }
      return compareRelevance(a, b, sortDir === 'asc' ? 'asc' : 'desc')
    })
  }

  private buildFacets(hits: SearchHit[]): FacetCounts {
    const merchants = new Map<string, number>()
    const productTypes = new Map<string, number>()
    for (const h of hits) {
      if (h.merchantName) merchants.set(h.merchantName, (merchants.get(h.merchantName) ?? 0) + 1)
      if (h.productType) productTypes.set(h.productType, (productTypes.get(h.productType) ?? 0) + 1)
    }
    return {
      merchant: this.toFacetBuckets(merchants),
      productType: this.toFacetBuckets(productTypes)
    }
  }

  /** Facets over full SQL match set (browse path — not just current page). */
  private buildFacetsSql(whereSql: string, params: Record<string, unknown>): FacetCounts {
    const merchantRows = this.db
      .prepare(
        `SELECT COALESCE(m.name, s.shop_name) AS value, COUNT(*) AS c
         FROM shop_products s
         LEFT JOIN merchants m ON m.id = s.merchant_id
         ${whereSql}
         GROUP BY value
         HAVING value IS NOT NULL AND value != ''
         ORDER BY c DESC
         LIMIT 30`
      )
      .all(params) as { value: string; c: number }[]
    const typeRows = this.db
      .prepare(
        `SELECT COALESCE(s.goods_type, s.category_name) AS value, COUNT(*) AS c
         FROM shop_products s
         LEFT JOIN merchants m ON m.id = s.merchant_id
         ${whereSql}
         GROUP BY value
         HAVING value IS NOT NULL AND value != ''
         ORDER BY c DESC
         LIMIT 30`
      )
      .all(params) as { value: string; c: number }[]
    return {
      merchant: merchantRows.map((r) => ({ value: r.value, count: r.c })),
      productType: typeRows.map((r) => ({ value: r.value, count: r.c }))
    }
  }

  private toFacetBuckets(m: Map<string, number>): { value: string; count: number }[] {
    return [...m.entries()]
      .map(([value, count]) => ({ value, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 30)
  }
}
