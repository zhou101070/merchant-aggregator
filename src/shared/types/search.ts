export type SearchHitKind = 'shop_product' | 'merchant'

export interface SearchHit {
  kind: SearchHitKind
  /** Stable row id: shop:{id} | merchant:{id} */
  id: string
  title: string
  subtitle?: string
  merchantId?: string | null
  merchantName?: string | null
  merchantHealth?: string | null
  price?: number | null
  currency?: string | null
  status?: string | null
  stockCount?: number | null
  platform?: string | null
  productType?: string | null
  sourceUrl?: string | null
  /** shop_products.source (platform id) — required for correct refresh */
  platformId?: string | null
  shopToken?: string | null
  shopGoodsKey?: string | null
  /** @deprecated dual-fill from shopGoodsKey */
  ldxpGoodsKey?: string | null
  /** @deprecated dual-fill from shopToken */
  ldxpToken?: string | null
  freshnessStatus?: string | null
  score: number
  fetchedAt?: string | null
}

export interface SearchQuery {
  q: string
  kinds?: SearchHitKind[]
  inStockOnly?: boolean
  priceMin?: number
  priceMax?: number
  /** Exact merchant display name filter (from facets) */
  merchantName?: string
  titleContains?: string[]
  /** 标题排除词(AND NOT LIKE) */
  titleExcludes?: string[]
  sort?: 'score' | 'price' | 'stock' | 'fetchedAt' | 'merchant' | 'title'
  sortDir?: 'asc' | 'desc'
  limit?: number
  offset?: number
}

export type FacetBucket = { value: string; count: number }
export type FacetCounts = Record<string, FacetBucket[]>

export type SearchEmptyReason = 'SHOP_PRODUCTS_NOT_SYNCED' | 'NO_MATCH'

export interface SearchResult {
  hits: SearchHit[]
  total: number
  emptyReason?: SearchEmptyReason
  facets?: FacetCounts
}

export interface SearchMeta {
  shopProductsCount: number
  readyForHero: boolean
}
