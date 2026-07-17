export interface Merchant {
  id: string
  name: string
  storeName: string | null
  host: string | null
  shopUrl: string | null
  entryUrl: string | null
  sourceId: string | null
  sourceName: string | null
  collectorKind: string | null
  /**
   * App-side health (not PriceAI):
   * healthy | failing | retrying | never | n/a
   */
  healthStatus: string | null
  /** Last app health update time */
  healthCheckedAt: string | null
  /** Optional detail, e.g. last scrape error */
  healthMessage: string | null
  /** PriceAI 上游健康度(原始 health_status),与本地同步状态区分 */
  upstreamHealth: string | null
  /** 本地已同步的店内商品数 */
  localProductCount: number
  offerCount: number
  inStockCount: number
  outOfStockCount: number
  productCount: number
  platformCount: number
  platforms: string[]
  productTypes: string[]
  representativeProduct: string | null
  representativeOfferTitle: string | null
  representativePrice: number | null
  representativeCurrency: string | null
  lowestHitCount: number
  warrantyLowestHitCount: number
  riskFeedbackCount: number
  hasPlatformAftersales: boolean
  shopCreatedAt: string | null
  includedAt: string | null
  lastSuccessAt: string | null
  latestSeenAt: string | null
  consecutiveFailures: number
  observationStartedAt: string | null
  generatedAt: string | null
  fetchedAt: string
  /** @deprecated prefer shopToken + shopPlatform; dual-filled when platform is ldxp */
  ldxpToken: string | null
  shopPlatform: string | null
  shopToken: string | null
}

/** 按搜索意图筛出的"可能有货且需要同步"的候选店 */
export interface MerchantCandidates {
  /** 需要同步的候选店 id(已排除新鲜期内的店) */
  merchantIds: string[]
  /** 匹配关键词的 ldxp 店总数(含已新鲜的) */
  totalMatching: number
  /** 候选店名示例(最多 5 个) */
  sample: string[]
}

export interface MerchantListQuery {
  q?: string
  platforms?: string[]
  health?: string[]
  host?: string
  /**
   * Only merchants with scrapable shop_platform + shop_token.
   * Canonical name; `ldxpOnly` is a deprecated alias accepted by list().
   */
  scrapableOnly?: boolean
  /** @deprecated use scrapableOnly */
  ldxpOnly?: boolean
  /** scrapable shops with zero local shop_products rows */
  withoutShopProducts?: boolean
  sort?: 'name' | 'price' | 'inStock' | 'offerCount' | 'updated'
  sortDir?: 'asc' | 'desc'
  offset: number
  limit: number
}
