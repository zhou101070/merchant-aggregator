import type { SavedSearch } from './saved-search'
import {
  AUTO_REFRESH_LIMITS,
  RATE_LIMITS,
  RECENT_SEARCHES_MAX,
  SHOP_FRESH_LIMITS
} from '../constants'
import { normalizeSavedSearches } from '../lib/saved-searches'

/** 外观主题:跟随系统 / 强制浅色 / 强制深色 */
export type ThemeMode = 'system' | 'light' | 'dark'

/** 旧数据阈值设置页单位 */
export type ShopFreshUnit = 'minutes' | 'hours'

const THEME_MODES = new Set<ThemeMode>(['system', 'light', 'dark'])
const SHOP_FRESH_UNITS = new Set<ShopFreshUnit>(['minutes', 'hours'])

export interface AppSettings {
  /** 已废弃：始终 false，保留字段兼容已存设置 */
  networkPaused: boolean
  priceaiUa: string
  /** PriceAI 商家列表分页间隔 — 固定默认值，保留字段兼容已存设置 */
  requestIntervalMs: number
  /**
   * 旧数据阈值（分钟，规范存储）。
   * 超过则视为需同步；「同步旧数据店铺」/自动刷新/UI 过期标注。
   */
  shopFreshMinutes: number
  /** 设置页展示单位（分钟/小时） */
  shopFreshUnit: ShopFreshUnit
  /**
   * @deprecated dual-fill with shopFreshMinutes / 60。读路径请用 shopFreshMinutes。
   */
  shopFreshHours: number
  /** Canonical: min interval between shop API requests */
  shopMinIntervalMs: number
  /** ShopAPI: concurrent goodsList pages — fixed at 1, kept for stored settings shape */
  shopPageConcurrency: number
  /** 已废弃：始终 true，保留字段兼容已存设置 */
  shopScrapeEnabled: boolean
  /**
   * @deprecated dual-written with shopMinIntervalMs for one release.
   * Prefer shopMinIntervalMs; readers coalesce both.
   */
  ldxpMinIntervalMs: number
  /**
   * @deprecated dual-written with shopScrapeEnabled; always true.
   */
  ldxpScrapeEnabled: boolean
  notifyOnJobFinished: boolean
  /** 店铺同步失败时自动写入屏蔽名单（有 merchantId 时） */
  blockOnShopSyncFail: boolean
  /** 外观主题,默认 system */
  theme: ThemeMode
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

function asShopFreshUnit(value: unknown, fallback: ShopFreshUnit): ShopFreshUnit {
  return typeof value === 'string' && SHOP_FRESH_UNITS.has(value as ShopFreshUnit)
    ? (value as ShopFreshUnit)
    : fallback
}

/** Coalesce minutes from new field or legacy hours; clamp + dual-write hours. */
export function coerceShopFreshMinutes(
  partial: Partial<AppSettings> | null | undefined,
  baseMinutes: number
): number {
  const lim = SHOP_FRESH_LIMITS.minutes
  let minutes: number
  if (partial && typeof partial.shopFreshMinutes === 'number' && Number.isFinite(partial.shopFreshMinutes)) {
    minutes = partial.shopFreshMinutes
  } else if (
    partial &&
    typeof partial.shopFreshHours === 'number' &&
    Number.isFinite(partial.shopFreshHours)
  ) {
    minutes = partial.shopFreshHours * 60
  } else {
    minutes = baseMinutes
  }
  minutes = Math.floor(minutes)
  return Math.min(lim.max, Math.max(lim.min, minutes))
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

  const shopScrapeEnabled = true

  const shopMinRaw = partial.shopMinIntervalMs ?? partial.ldxpMinIntervalMs
  const shopMinIntervalMs = Math.max(
    RATE_LIMITS.shopMinIntervalMs.min,
    asFiniteNumber(shopMinRaw, base.shopMinIntervalMs)
  )

  const shopPageConcurrency = 1
  const requestIntervalMs = RATE_LIMITS.priceaiMerchantsIntervalMs.default

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

  const shopFreshMinutes = coerceShopFreshMinutes(partial, base.shopFreshMinutes)
  // 双写小时字段，兼容仍读 shopFreshHours 的旧路径
  const shopFreshHours = shopFreshMinutes / 60
  const shopFreshUnit = asShopFreshUnit(partial.shopFreshUnit, base.shopFreshUnit)

  const next: AppSettings = {
    ...base,
    ...partial,
    networkPaused: false,
    shopScrapeEnabled,
    shopMinIntervalMs,
    shopPageConcurrency,
    requestIntervalMs,
    shopFreshMinutes,
    shopFreshHours,
    shopFreshUnit,
    ldxpScrapeEnabled: shopScrapeEnabled,
    ldxpMinIntervalMs: shopMinIntervalMs,
    theme: asThemeMode(partial.theme, base.theme),
    blockOnShopSyncFail: asBoolean(partial.blockOnShopSyncFail, base.blockOnShopSyncFail),
    autoRefreshEnabled: asBoolean(partial.autoRefreshEnabled, base.autoRefreshEnabled),
    ...clampAutoRefreshIntervals(partial, base),
    recentSearches,
    searchExcludeWords,
    savedSearches
  }
  // 剥离已废弃字段（旧 settings JSON 可能仍带）
  delete (next as AppSettings & { openExternalMode?: unknown }).openExternalMode
  delete (next as AppSettings & { allowlistHosts?: unknown }).allowlistHosts
  delete (next as AppSettings & { proxyCoreEnabled?: unknown }).proxyCoreEnabled
  delete (next as AppSettings & { proxySubscriptionUrl?: unknown }).proxySubscriptionUrl
  delete (next as AppSettings & { proxySubscriptions?: unknown }).proxySubscriptions
  delete (next as AppSettings & { proxyCallLogEnabled?: unknown }).proxyCallLogEnabled
  return next
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
  // 深刮总开关已移除，固定开启
  if (partial.shopScrapeEnabled !== undefined || partial.ldxpScrapeEnabled !== undefined) {
    out.shopScrapeEnabled = true
    out.ldxpScrapeEnabled = true
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
  // 店刮并发固定为 1，忽略外部补丁
  if (partial.shopPageConcurrency !== undefined) {
    out.shopPageConcurrency = 1
  }
  // 旧数据阈值：分钟规范 + 双写小时
  if (partial.shopFreshMinutes !== undefined || partial.shopFreshHours !== undefined) {
    const minutes = coerceShopFreshMinutes(partial, SHOP_FRESH_LIMITS.minutes.default)
    out.shopFreshMinutes = minutes
    out.shopFreshHours = minutes / 60
  }
  if (partial.shopFreshUnit !== undefined) {
    out.shopFreshUnit = asShopFreshUnit(partial.shopFreshUnit, 'hours')
  }
  if (Array.isArray(partial.recentSearches)) {
    out.recentSearches = partial.recentSearches
      .filter((s): s is string => typeof s === 'string' && s.trim().length > 0)
      .map((s) => s.trim())
      .slice(0, RECENT_SEARCHES_MAX)
  }
  return out
}
