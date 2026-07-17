/** Raw PriceAI API shapes (pre-normalize). */

export interface PriceaiMerchantsPage {
  rows: PriceaiMerchantRaw[]
  total: number
  message: string | null
  degraded: boolean
  generatedAt: string | null
  limited: boolean
  limit: number
  offset: number
}

export interface PriceaiMerchantRaw {
  id: string
  name: string
  storeName?: string | null
  host?: string | null
  shopUrl?: string | null
  entryUrl?: string | null
  sourceId?: string | null
  sourceName?: string | null
  collectorKind?: string | null
  healthStatus?: string | null
  offerCount?: number | null
  inStockCount?: number | null
  outOfStockCount?: number | null
  productCount?: number | null
  platformCount?: number | null
  platforms?: string[] | null
  productTypes?: string[] | null
  representativeProduct?: string | null
  representativeOfferTitle?: string | null
  representativePrice?: number | null
  representativeCurrency?: string | null
  lowestHitCount?: number | null
  warrantyLowestHitCount?: number | null
  riskFeedbackCount?: number | null
  hasPlatformAftersalesMechanism?: boolean | null
  shopCreatedAt?: string | null
  includedAt?: string | null
  lastSuccessAt?: string | null
  latestSeenAt?: string | null
  consecutiveFailures?: number | null
  observationStartedAt?: string | null
  [key: string]: unknown
}
