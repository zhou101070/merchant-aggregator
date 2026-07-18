import type { SavedSearch } from './types/saved-search'
import type { AppSettings } from './types/settings'

/**
 * Default PriceAI UA override in settings.
 * Empty → main process uses resolveRequestUserAgent() (desktop Chrome).
 * Non-empty custom string is sent as-is.
 */
export const DEFAULT_PRICEAI_UA = ''

/** Pre-unification identifiable UA; treated as empty by resolveRequestUserAgent. */
export const LEGACY_IDENTIFIABLE_PRICEAI_UA =
  'MerchantAggregator/1.0 (+personal-research; contact: local-user)'

export const DEFAULT_APP_SETTINGS: AppSettings = {
  networkPaused: false,
  priceaiUa: DEFAULT_PRICEAI_UA,
  requestIntervalMs: 500,
  shopFreshHours: 24,
  shopMinIntervalMs: 500,
  /** ShopAPI 单店分页并发页数 */
  shopPageConcurrency: 3,
  shopScrapeEnabled: true,
  /** @deprecated dual-fill with shopMinIntervalMs */
  ldxpMinIntervalMs: 500,
  /** @deprecated dual-fill with shopScrapeEnabled */
  ldxpScrapeEnabled: true,
  notifyOnJobFinished: false,
  blockOnShopSyncFail: false,
  theme: 'system',
  proxyCoreEnabled: false,
  proxySubscriptionUrl: '',
  proxySubscriptions: [],
  proxyCallLogEnabled: false,
  /** 程序运行期间按平台独立随机刷新店铺（须用户显式开启） */
  autoRefreshEnabled: false,
  /** 每平台两次自动刷新之间的最短间隔 */
  autoRefreshMinIntervalMs: 3 * 60_000,
  /** 每平台两次自动刷新之间的最长间隔 */
  autoRefreshMaxIntervalMs: 12 * 60_000,
  recentSearches: [],
  searchExcludeWords: [],
  savedSearches: [] as SavedSearch[]
}

/** Pinned mihomo release for first-run download (MetaCubeX/mihomo). */
export const PROXY_CORE_MIHOMO_VERSION = 'v1.19.12'

/** Auto-refresh interval clamp (ms). */
export const AUTO_REFRESH_LIMITS = {
  minIntervalMs: { min: 60_000, max: 24 * 60 * 60_000, default: 3 * 60_000 },
  maxIntervalMs: { min: 60_000, max: 24 * 60 * 60_000, default: 12 * 60_000 }
} as const

export const RATE_LIMITS = {
  priceaiMerchantsIntervalMs: { min: 300, max: 800, default: 500 },
  shopMinIntervalMs: { min: 500, default: 500 },
  /** @deprecated use shopMinIntervalMs */
  ldxpMinIntervalMs: { min: 500, default: 500 },
  requestTimeoutMs: 25_000,
  maxRetries: 3,
  circuitBreakerFailures: 5
} as const

export const SEARCH_DEFAULTS = {
  limit: 50,
  offset: 0,
  /** 搜索结果屏蔽该价及以下(占位/垃圾 SKU),仅作用于 SearchService */
  hidePriceAtOrBelow: 0.02,
  /** 搜索结果屏蔽该价及以上(异常高价/非标),仅作用于 SearchService */
  hidePriceAtOrAbove: 5000
} as const

/** Page size / concurrency for shopApi-family goodsList. */
export const SHOP_API_LIMITS = {
  defaultPageSize: 20,
  maxPageSize: 50,
  /** Concurrent goodsList pages per goods type */
  pageConcurrency: { min: 1, max: 10, default: 3 }
} as const

/** 一键初始化时深刮的店铺数(按报价数排序取前 N) */
export const BOOTSTRAP_TOP_N = 50

/** SQLite schema user_version for migrations. */
export const DB_SCHEMA_VERSION = 11

/** 抓取失败后的换节点重试策略 */
export const PROXY_NODE_RETRY = {
  /** 单店失败后最多尝试的其他节点数 */
  maxNodes: 3,
  /** 「节点在平台不可用」记录的过期时长 */
  badNodeTtlHours: 24
} as const

/**
 * 代理节点动态打分（见 docs/NODE-SCORE.md）。
 * enabled=false 时 pick 回退 delay 序，record* 为 no-op。
 */
export const NODE_SCORE = {
  enabled: true,
  alpha: 0.3,
  alphaHeal: 0.3,
  failPenaltyBaseMs: 3_000,
  failPenaltyMaxMs: 15_000,
  failPenaltyMultiplier: 4,
  floorMs: 50,
  temperature: 1.5,
  failStreakSoftCap: 5,
  failWeightMin: 0.15,
  failWeightStep: 0.15,
  minSamplesPreferEwma: 3,
  neutralMs: 500,
  idleClearMs: 7 * 24 * 3_600_000
} as const

/** Cap for settings.recentSearches */
export const RECENT_SEARCHES_MAX = 12

/** Cap for settings.savedSearches */
export const SAVED_SEARCHES_MAX = 20

export const APP_NAME = 'Merchant Aggregator'
