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

export const DEFAULT_ALLOWLIST_HOSTS = [
  'priceai.cc',
  'www.priceai.cc',
  'pay.ldxp.cn',
  'ldxp.cn',
  'www.ldxp.cn',
  'qn.ldxp.cn',
  'catfk.com',
  'www.catfk.com'
] as const

export const DEFAULT_APP_SETTINGS: AppSettings = {
  networkPaused: false,
  priceaiUa: DEFAULT_PRICEAI_UA,
  requestIntervalMs: 500,
  shopFreshHours: 24,
  shopMinIntervalMs: 500,
  shopScrapeEnabled: true,
  /** @deprecated dual-fill with shopMinIntervalMs */
  ldxpMinIntervalMs: 500,
  /** @deprecated dual-fill with shopScrapeEnabled */
  ldxpScrapeEnabled: true,
  openExternalMode: 'allowlist_confirm',
  allowlistHosts: [...DEFAULT_ALLOWLIST_HOSTS],
  notifyOnJobFinished: false,
  recentSearches: [],
  searchExcludeWords: [],
  savedSearches: [] as SavedSearch[]
}

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

/** Page size for shopApi-family goodsList (all shopApi profiles). */
export const SHOP_API_LIMITS = {
  defaultPageSize: 20,
  maxPageSize: 50
} as const

/** 一键初始化时深刮的店铺数(按报价数排序取前 N) */
export const BOOTSTRAP_TOP_N = 50

/** SQLite schema user_version for migrations. */
export const DB_SCHEMA_VERSION = 6

/** Cap for settings.recentSearches */
export const RECENT_SEARCHES_MAX = 12

/** Cap for settings.savedSearches */
export const SAVED_SEARCHES_MAX = 20

export const APP_NAME = 'Merchant Aggregator'
