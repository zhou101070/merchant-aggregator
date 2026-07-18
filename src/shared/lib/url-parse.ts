import { SHOP_PROFILES } from '../platforms/shop-profiles'
import type { ShopSiteProfile } from '../platforms/shop-types'
import { findProfileByHost, shopRootUrl } from '../platforms/shop-types'

const SHOP_PATH = /\/shop\/([A-Za-z0-9_.-]+)/i
const ITEM_PATH = /\/item\/([A-Za-z0-9_.-]+)/i

export interface ParsedShopUrl {
  platformId: string
  token: string
  baseUrl: string
  shopUrl: string
  profileEnabled: boolean
  profile: ShopSiteProfile
}

function tryParseHttpUrl(input: string): URL | null {
  try {
    if (!input.includes('://')) return null
    const url = new URL(input)
    // Only http(s): non-http schemes can still expose a matching hostname
    // (e.g. javascript://pay.ldxp.cn/shop/TOKEN) and must not host-gate.
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
    if (url.username || url.password) return null
    return url
  } catch {
    return null
  }
}

/**
 * Host-gated shop URL parse.
 *
 * Absolute rules:
 * 1) Full http(s) URL: hostname must match a registered profile host; then accept /shop/:token
 * 2) Path-only `/shop/xxx` without host → null
 * 3) Bare token → null (caller must pass platformId explicitly)
 * 4) Non-http(s) schemes → null
 *
 * Uses ALL registered profiles (including enabled:false) so known-but-disabled
 * hosts resolve correctly and surface PAUSED rather than wrong-platform scrape.
 */
export function parseShopUrl(
  input: string | null | undefined,
  profiles: readonly ShopSiteProfile[] = SHOP_PROFILES
): ParsedShopUrl | null {
  if (!input) return null
  const trimmed = input.trim()
  if (!trimmed) return null

  const url = tryParseHttpUrl(trimmed)
  if (!url) return null

  const profile = findProfileByHost(url.hostname, profiles)
  if (!profile) return null

  const m = url.pathname.match(SHOP_PATH)
  if (!m?.[1]) return null

  const token = m[1]
  return {
    platformId: profile.id,
    token,
    baseUrl: profile.baseUrl,
    shopUrl: shopRootUrl(profile, token),
    profileEnabled: profile.enabled,
    profile
  }
}

/** Platform-aware item key extraction (any registered host). */
export function parseShopItemKey(
  input: string | null | undefined,
  profiles: readonly ShopSiteProfile[] = SHOP_PROFILES
): { platformId: string; goodsKey: string; profile: ShopSiteProfile } | null {
  if (!input) return null
  const trimmed = input.trim()
  if (!trimmed) return null
  const url = tryParseHttpUrl(trimmed)
  if (!url) return null
  const profile = findProfileByHost(url.hostname, profiles)
  if (!profile) return null
  const m = url.pathname.match(ITEM_PATH)
  if (!m?.[1]) return null
  return { platformId: profile.id, goodsKey: m[1], profile }
}
