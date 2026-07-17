export type OpenExternalMode = 'allowlist_confirm' | 'allowlist_reject' | 'https_only'

export interface AppSettings {
  networkPaused: boolean
  priceaiUa: string
  requestIntervalMs: number
  /** 商品价格新鲜期(小时):增量同步跳过此期限内成功的店;UI 超龄标注 */
  shopFreshHours: number
  /** Canonical: min interval between shop API requests */
  shopMinIntervalMs: number
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
  /** allowlist hosts open directly; non-allowlist confirm first (K24) */
  openExternalMode: OpenExternalMode
  allowlistHosts: string[]
  notifyOnJobFinished: boolean
}

/** Coalesce legacy ldxp_* keys with new shop_* keys onto a full settings object. */
export function coalesceAppSettings(
  defaults: AppSettings,
  partial: Partial<AppSettings> | null | undefined
): AppSettings {
  const base: AppSettings = {
    ...defaults,
    allowlistHosts: [...defaults.allowlistHosts]
  }
  if (!partial) return base

  const shopScrapeEnabled =
    partial.shopScrapeEnabled ?? partial.ldxpScrapeEnabled ?? base.shopScrapeEnabled
  const shopMinIntervalMs =
    partial.shopMinIntervalMs ?? partial.ldxpMinIntervalMs ?? base.shopMinIntervalMs

  return {
    ...base,
    ...partial,
    shopScrapeEnabled,
    shopMinIntervalMs,
    ldxpScrapeEnabled: shopScrapeEnabled,
    ldxpMinIntervalMs: shopMinIntervalMs,
    allowlistHosts: partial.allowlistHosts ?? base.allowlistHosts
  }
}

/** Ensure dual-write of shop_* and ldxp_* when applying a partial patch. */
export function dualWriteSettingsPatch(partial: Partial<AppSettings>): Partial<AppSettings> {
  const out: Partial<AppSettings> = { ...partial }
  if (partial.shopScrapeEnabled !== undefined) {
    out.ldxpScrapeEnabled = partial.shopScrapeEnabled
  } else if (partial.ldxpScrapeEnabled !== undefined) {
    out.shopScrapeEnabled = partial.ldxpScrapeEnabled
    out.ldxpScrapeEnabled = partial.ldxpScrapeEnabled
  }
  if (partial.shopMinIntervalMs !== undefined) {
    out.ldxpMinIntervalMs = partial.shopMinIntervalMs
  } else if (partial.ldxpMinIntervalMs !== undefined) {
    out.shopMinIntervalMs = partial.ldxpMinIntervalMs
    out.ldxpMinIntervalMs = partial.ldxpMinIntervalMs
  }
  return out
}
