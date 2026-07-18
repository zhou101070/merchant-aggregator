import type { SavedSearch } from './saved-search'
import {
  AUTO_REFRESH_LIMITS,
  RATE_LIMITS,
  RECENT_SEARCHES_MAX,
  SHOP_API_LIMITS
} from '../constants'
import { normalizeSavedSearches } from '../lib/saved-searches'
import {
  normalizeProxySubscriptions,
  primaryProxySubscriptionUrl,
  type ProxySubscription
} from './proxy-subscription'

/** 外观主题:跟随系统 / 强制浅色 / 强制深色 */
export type ThemeMode = 'system' | 'light' | 'dark'

const THEME_MODES = new Set<ThemeMode>(['system', 'light', 'dark'])

export interface AppSettings {
  networkPaused: boolean
  priceaiUa: string
  requestIntervalMs: number
  /** 旧数据阈值(小时):超过则视为需同步;「同步旧数据店铺」/自动刷新/UI 过期标注 */
  shopFreshHours: number
  /** Canonical: min interval between shop API requests */
  shopMinIntervalMs: number
  /** ShopAPI: concurrent goodsList pages per goods type */
  shopPageConcurrency: number
  /** Canonical: allow shop deep-scrape jobs */
  shopScrapeEnabled: boolean
  /**
   * @deprecated dual-written with shopMinIntervalMs for one release.
   * Prefer shopMinIntervalMs; readers coalesce both.
   */
  ldxpMinIntervalMs: number
  /**
   * @deprecated dual-written with shopScrapeEnabled for one release.
   */
  ldxpScrapeEnabled: boolean
  notifyOnJobFinished: boolean
  /** 店铺同步失败时自动写入屏蔽名单（有 merchantId 时） */
  blockOnShopSyncFail: boolean
  /** 外观主题,默认 system */
  theme: ThemeMode
  /** 启用内置代理内核（订阅 → load-balance → 本地 mixed-port） */
  proxyCoreEnabled: boolean
  /**
   * @deprecated dual-written from proxySubscriptions[0] for one release.
   * Prefer proxySubscriptions.
   */
  proxySubscriptionUrl: string
  /** 多订阅：每个 URL 为一组（仅存本地 settings） */
  proxySubscriptions: ProxySubscription[]
  /** 记录节点调用日志（内存环形缓冲，默认关） */
  proxyCallLogEnabled: boolean
  /** 程序运行中自动刷新店铺（按平台独立随机间隔） */
  autoRefreshEnabled: boolean
  /** 每平台自动刷新最短间隔 ms */
  autoRefreshMinIntervalMs: number
  /** 每平台自动刷新最长间隔 ms（≥ min） */
  autoRefreshMaxIntervalMs: number
  /** 最近搜索关键词(新在前)，上限见 RECENT_SEARCHES_MAX */
  recentSearches: string[]
  /** 搜索标题排除词(持久化，启动即生效) */
  searchExcludeWords: string[]
  /** 用户主动保存的常用搜索(新在前)，上限见 SAVED_SEARCHES_MAX */
  savedSearches: SavedSearch[]
}

function asThemeMode(value: unknown, fallback: ThemeMode): ThemeMode {
  return typeof value === 'string' && THEME_MODES.has(value as ThemeMode)
    ? (value as ThemeMode)
    : fallback
}

function asBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback
}

function asFiniteNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function clampAutoRefreshIntervals(
  partial: Partial<AppSettings>,
  base: AppSettings
): Pick<AppSettings, 'autoRefreshMinIntervalMs' | 'autoRefreshMaxIntervalMs'> {
  const lim = AUTO_REFRESH_LIMITS
  let minMs = Math.floor(
    asFiniteNumber(partial.autoRefreshMinIntervalMs, base.autoRefreshMinIntervalMs)
  )
  let maxMs = Math.floor(
    asFiniteNumber(partial.autoRefreshMaxIntervalMs, base.autoRefreshMaxIntervalMs)
  )
  minMs = Math.min(lim.minIntervalMs.max, Math.max(lim.minIntervalMs.min, minMs))
  maxMs = Math.min(lim.maxIntervalMs.max, Math.max(lim.maxIntervalMs.min, maxMs))
  if (maxMs < minMs) maxMs = minMs
  return { autoRefreshMinIntervalMs: minMs, autoRefreshMaxIntervalMs: maxMs }
}

/** Coalesce legacy ldxp_* keys with new shop_* keys onto a full settings object. */
export function coalesceAppSettings(
  defaults: AppSettings,
  partial: Partial<AppSettings> | null | undefined
): AppSettings {
  const base: AppSettings = { ...defaults }
  if (!partial) return base

  const shopScrapeRaw = partial.shopScrapeEnabled ?? partial.ldxpScrapeEnabled
  const shopScrapeEnabled = asBoolean(shopScrapeRaw, base.shopScrapeEnabled)

  const shopMinRaw = partial.shopMinIntervalMs ?? partial.ldxpMinIntervalMs
  const shopMinIntervalMs = Math.max(
    RATE_LIMITS.shopMinIntervalMs.min,
    asFiniteNumber(shopMinRaw, base.shopMinIntervalMs)
  )

  const pageConcLim = SHOP_API_LIMITS.pageConcurrency
  const shopPageConcurrency = Math.min(
    pageConcLim.max,
    Math.max(
      pageConcLim.min,
      Math.floor(asFiniteNumber(partial.shopPageConcurrency, base.shopPageConcurrency))
    )
  )

  const recentSearches = Array.isArray(partial.recentSearches)
    ? partial.recentSearches
        .filter((s): s is string => typeof s === 'string' && s.trim().length > 0)
        .map((s) => s.trim())
        .slice(0, RECENT_SEARCHES_MAX)
    : base.recentSearches

  const searchExcludeWords = Array.isArray(partial.searchExcludeWords)
    ? normalizeWordList(partial.searchExcludeWords)
    : base.searchExcludeWords

  const savedSearches =
    partial.savedSearches !== undefined
      ? normalizeSavedSearches(partial.savedSearches)
      : base.savedSearches

  const next: AppSettings = {
    ...base,
    ...partial,
    shopScrapeEnabled,
    shopMinIntervalMs,
    shopPageConcurrency,
    ldxpScrapeEnabled: shopScrapeEnabled,
    ldxpMinIntervalMs: shopMinIntervalMs,
    theme: asThemeMode(partial.theme, base.theme),
    proxyCoreEnabled: asBoolean(partial.proxyCoreEnabled, base.proxyCoreEnabled),
    ...coalesceProxySubscriptions(partial, base),
    proxyCallLogEnabled: asBoolean(partial.proxyCallLogEnabled, base.proxyCallLogEnabled),
    blockOnShopSyncFail: asBoolean(partial.blockOnShopSyncFail, base.blockOnShopSyncFail),
    autoRefreshEnabled: asBoolean(partial.autoRefreshEnabled, base.autoRefreshEnabled),
    ...clampAutoRefreshIntervals(partial, base),
    recentSearches,
    searchExcludeWords,
    savedSearches
  }
  // 剥离已废弃的白名单字段（旧 settings JSON 可能仍带）
  delete (next as AppSettings & { openExternalMode?: unknown }).openExternalMode
  delete (next as AppSettings & { allowlistHosts?: unknown }).allowlistHosts
  return next
}

function coalesceProxySubscriptions(
  partial: Partial<AppSettings>,
  base: AppSettings
): Pick<AppSettings, 'proxySubscriptions' | 'proxySubscriptionUrl'> {
  let subs: ProxySubscription[]
  if (partial.proxySubscriptions !== undefined) {
    subs = normalizeProxySubscriptions(partial.proxySubscriptions)
  } else {
    subs = normalizeProxySubscriptions(base.proxySubscriptions)
  }

  const legacyUrl =
    typeof partial.proxySubscriptionUrl === 'string'
      ? partial.proxySubscriptionUrl.trim()
      : base.proxySubscriptionUrl?.trim() || ''

  // Migrate single legacy URL when list empty
  if (subs.length === 0 && legacyUrl) {
    subs = normalizeProxySubscriptions([
      { id: 'legacy', url: legacyUrl, name: '订阅 1', enabled: true }
    ])
  }

  // Dual-write primary URL for older readers
  const proxySubscriptionUrl = primaryProxySubscriptionUrl(subs) || legacyUrl
  return { proxySubscriptions: subs, proxySubscriptionUrl }
}

/** trim + 去空 + 保序去重 */
export function normalizeWordList(words: string[]): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const raw of words) {
    if (typeof raw !== 'string') continue
    const t = raw.trim()
    if (!t) continue
    const key = t.toLocaleLowerCase('zh-CN')
    if (seen.has(key)) continue
    seen.add(key)
    out.push(t)
  }
  return out
}

/** Ensure dual-write of shop_* and ldxp_* when applying a partial patch. */
export function dualWriteSettingsPatch(partial: Partial<AppSettings>): Partial<AppSettings> {
  const out: Partial<AppSettings> = { ...partial }
  if (partial.shopScrapeEnabled !== undefined) {
    if (typeof partial.shopScrapeEnabled === 'boolean') {
      out.shopScrapeEnabled = partial.shopScrapeEnabled
      out.ldxpScrapeEnabled = partial.shopScrapeEnabled
    } else {
      delete out.shopScrapeEnabled
    }
  } else if (partial.ldxpScrapeEnabled !== undefined) {
    if (typeof partial.ldxpScrapeEnabled === 'boolean') {
      out.shopScrapeEnabled = partial.ldxpScrapeEnabled
      out.ldxpScrapeEnabled = partial.ldxpScrapeEnabled
    } else {
      delete out.ldxpScrapeEnabled
    }
  }
  if (partial.shopMinIntervalMs !== undefined) {
    if (typeof partial.shopMinIntervalMs === 'number' && Number.isFinite(partial.shopMinIntervalMs)) {
      const n = Math.max(RATE_LIMITS.shopMinIntervalMs.min, partial.shopMinIntervalMs)
      out.shopMinIntervalMs = n
      out.ldxpMinIntervalMs = n
    } else {
      delete out.shopMinIntervalMs
    }
  } else if (partial.ldxpMinIntervalMs !== undefined) {
    if (typeof partial.ldxpMinIntervalMs === 'number' && Number.isFinite(partial.ldxpMinIntervalMs)) {
      const n = Math.max(RATE_LIMITS.shopMinIntervalMs.min, partial.ldxpMinIntervalMs)
      out.shopMinIntervalMs = n
      out.ldxpMinIntervalMs = n
    } else {
      delete out.ldxpMinIntervalMs
    }
  }
  if (partial.shopPageConcurrency !== undefined) {
    if (
      typeof partial.shopPageConcurrency === 'number' &&
      Number.isFinite(partial.shopPageConcurrency)
    ) {
      const lim = SHOP_API_LIMITS.pageConcurrency
      out.shopPageConcurrency = Math.min(
        lim.max,
        Math.max(lim.min, Math.floor(partial.shopPageConcurrency))
      )
    } else {
      delete out.shopPageConcurrency
    }
  }
  if (Array.isArray(partial.recentSearches)) {
    out.recentSearches = partial.recentSearches
      .filter((s): s is string => typeof s === 'string' && s.trim().length > 0)
      .map((s) => s.trim())
      .slice(0, RECENT_SEARCHES_MAX)
  }
  if (partial.proxySubscriptions !== undefined) {
    const subs = normalizeProxySubscriptions(partial.proxySubscriptions)
    out.proxySubscriptions = subs
    out.proxySubscriptionUrl = primaryProxySubscriptionUrl(subs)
  } else if (typeof partial.proxySubscriptionUrl === 'string') {
    // Legacy-only patch: dual-write a single-item list (or clear primary)
    const url = partial.proxySubscriptionUrl.trim()
    out.proxySubscriptionUrl = url
    if (url) {
      out.proxySubscriptions = normalizeProxySubscriptions([
        { id: 'legacy', url, name: '订阅 1', enabled: true }
      ])
      // Invalid scheme → normalize drops it; keep primary empty too
      out.proxySubscriptionUrl = primaryProxySubscriptionUrl(out.proxySubscriptions)
    }
  }
  return out
}
