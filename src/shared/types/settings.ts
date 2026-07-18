import type { SavedSearch } from './saved-search'
import { RATE_LIMITS, RECENT_SEARCHES_MAX, SHOP_API_LIMITS } from '../constants'
import { normalizeSavedSearches } from '../lib/saved-searches'

/** 外观主题:跟随系统 / 强制浅色 / 强制深色 */
export type ThemeMode = 'system' | 'light' | 'dark'

const THEME_MODES = new Set<ThemeMode>(['system', 'light', 'dark'])

export interface AppSettings {
  networkPaused: boolean
  priceaiUa: string
  requestIntervalMs: number
  /** 商品价格新鲜期(小时):增量同步跳过此期限内成功的店;UI 超龄标注 */
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
  /** 外观主题,默认 system */
  theme: ThemeMode
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
    recentSearches,
    searchExcludeWords,
    savedSearches
  }
  // 剥离已废弃的白名单字段（旧 settings JSON 可能仍带）
  delete (next as AppSettings & { openExternalMode?: unknown }).openExternalMode
  delete (next as AppSettings & { allowlistHosts?: unknown }).allowlistHosts
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
  return out
}
