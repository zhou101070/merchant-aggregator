import {
  identifyShopPlatform,
  identityToScrapeRef,
  isIdentityScrapable,
  type ShopIdentity
} from '@shared/platforms/identify'

const SHOP_PATH_TOKEN = /\/shop\/([A-Za-z0-9_.-]+)/i

function hostFromUrls(...urls: Array<string | null | undefined>): string | null {
  for (const raw of urls) {
    if (!raw?.trim()) continue
    try {
      const u = new URL(raw.includes('://') ? raw.trim() : `https://${raw.trim()}`)
      if (u.protocol !== 'http:' && u.protocol !== 'https:') continue
      const h = u.hostname.trim().toLowerCase()
      if (h) return h
    } catch {
      /* continue */
    }
  }
  return null
}

function isHostnameLike(value: string): boolean {
  const v = value.trim().toLowerCase()
  if (!v || v.includes('/') || v.includes(' ')) return false
  return v.includes('.') || /^localhost(:\d+)?$/i.test(v)
}

function shopPathToken(...urls: Array<string | null | undefined>): string | null {
  for (const raw of urls) {
    if (!raw?.trim()) continue
    try {
      const u = new URL(raw.includes('://') ? raw.trim() : `https://${raw.trim()}`)
      const m = u.pathname.match(SHOP_PATH_TOKEN)
      if (m?.[1]) return m[1]
    } catch {
      const m = raw.match(SHOP_PATH_TOKEN)
      if (m?.[1]) return m[1]
    }
  }
  return null
}

/** Coalesce dual-write shop / legacy ldxp fields via identifyShopPlatform. */
export function resolveShopRef(input: {
  platformId?: string | null
  shopPlatform?: string | null
  shopToken?: string | null
  ldxpToken?: string | null
  shopUrl?: string | null
  entryUrl?: string | null
  host?: string | null
  collectorKind?: string | null
  /** When true, missing platform returns null instead of defaulting to ldxp */
  strictPlatform?: boolean
}): { platformId: string; token: string } | null {
  const identity = identifyShopPlatform({
    host: input.host,
    shopUrl: input.shopUrl,
    entryUrl: input.entryUrl,
    shopPlatform: input.platformId || input.shopPlatform,
    shopToken: input.shopToken,
    ldxpToken: input.ldxpToken,
    collectorKind: input.collectorKind
  })
  const ref = identityToScrapeRef(identity)
  if (ref) return ref
  if (input.strictPlatform) return null
  // Legacy fallback only when token present without platform (pre-identify paths)
  const token = (input.shopToken || input.ldxpToken || '').trim()
  if (!token) return null
  const platformId = (input.platformId || input.shopPlatform || '').trim()
  if (platformId) return { platformId, token }
  return { platformId: 'ldxp', token }
}

/** Full identity for UI (type badge / why not scrapable). */
export function resolveShopIdentity(input: {
  shopPlatform?: string | null
  shopToken?: string | null
  ldxpToken?: string | null
  shopUrl?: string | null
  entryUrl?: string | null
  host?: string | null
  collectorKind?: string | null
}): ShopIdentity {
  return identifyShopPlatform(input)
}

/**
 * Unknown / non-scrapable shops with host or shop token can still try known modes.
 * UI uses this to offer「同步该店商品」without claiming a confirmed platform.
 */
export function canTrialUnknownShopSync(input: {
  shopPlatform?: string | null
  shopToken?: string | null
  ldxpToken?: string | null
  shopUrl?: string | null
  entryUrl?: string | null
  host?: string | null
  collectorKind?: string | null
}): boolean {
  const identity = identifyShopPlatform(input)
  if (isIdentityScrapable(identity)) return false
  // Known shopapi (incl. paused) is not an unknown trial
  if (identity.scrapeStrategy === 'shopapi' && identity.platformId) return false

  const host = (input.host || '').trim().toLowerCase() || hostFromUrls(input.shopUrl, input.entryUrl)
  if (host) return true
  if (shopPathToken(input.shopUrl, input.entryUrl)) return true
  const token = (input.shopToken || input.ldxpToken || identity.token || '').trim()
  if (token && !isHostnameLike(token)) return true
  if (token && isHostnameLike(token)) return true
  return false
}

/** True when the merchant can start a shop product sync (known scrapable or unknown trial). */
export function canSyncShopProducts(input: {
  shopPlatform?: string | null
  shopToken?: string | null
  ldxpToken?: string | null
  shopUrl?: string | null
  entryUrl?: string | null
  host?: string | null
  collectorKind?: string | null
}): boolean {
  const identity = identifyShopPlatform(input)
  if (isIdentityScrapable(identity)) return true
  return canTrialUnknownShopSync(input)
}

/**
 * Ref for shop_one start. Prefer confirmed scrape ref; for unknown trial use host/token material.
 */
export function resolveShopSyncStartRef(input: {
  shopPlatform?: string | null
  shopToken?: string | null
  ldxpToken?: string | null
  shopUrl?: string | null
  entryUrl?: string | null
  host?: string | null
  collectorKind?: string | null
  merchantId?: string | null
}): { platformId: string; token: string; merchantId?: string } | null {
  const identity = identifyShopPlatform(input)
  const ref = identityToScrapeRef(identity)
  if (ref) {
    return {
      platformId: ref.platformId,
      token: ref.token,
      merchantId: input.merchantId ?? undefined
    }
  }
  if (!canTrialUnknownShopSync(input)) return null
  const host = (input.host || '').trim().toLowerCase() || hostFromUrls(input.shopUrl, input.entryUrl)
  const token =
    host ||
    (input.shopToken || input.ldxpToken || identity.token || '').trim() ||
    shopPathToken(input.shopUrl, input.entryUrl)
  if (!token) return null
  const platformId =
    (input.shopPlatform || identity.platformId || 'unknown').trim() || 'unknown'
  return {
    platformId,
    token,
    merchantId: input.merchantId ?? undefined
  }
}
