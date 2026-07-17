import { SHOP_PROFILES } from '../platforms/shop-profiles'
import type { ShopSiteProfile } from '../platforms/shop-types'
import { findProfileByHost, shopRootUrl } from '../platforms/shop-types'

const SHOP_PATH = /\/shop\/([A-Za-z0-9]+)/i
const ITEM_PATH = /\/item\/([A-Za-z0-9]+)/i
const TOKEN_ONLY = /^[A-Za-z0-9]{6,16}$/

export interface ParsedShopUrl {
  platformId: string
  token: string
  baseUrl: string
  shopUrl: string
  profileEnabled: boolean
  profile: ShopSiteProfile
}

function tryParseUrl(input: string): URL | null {
  try {
    if (input.includes('://')) return new URL(input)
  } catch {
    // fall through
  }
  return null
}

/**
 * Host-gated shop URL parse.
 *
 * Absolute rules:
 * 1) Full URL: hostname must match a registered profile host; then accept /shop/:token
 * 2) Path-only `/shop/xxx` without host → null
 * 3) Bare token → null (caller must pass platformId explicitly)
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

  const url = tryParseUrl(trimmed)
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

/**
 * Compat helper for legacy call sites that only need an ldxp token string.
 *
 * - Full ldxp shop URL → token
 * - Bare token (TOKEN_ONLY) → token (historical behavior)
 * - Non-ldxp registered host (e.g. catfk.com/shop/…) → **null** (bugfix: no longer mis-attributed)
 * - Unknown host with /shop/ path → **null**
 */
export function parseLdxpShopToken(input: string | null | undefined): string | null {
  if (!input) return null
  const trimmed = input.trim()
  if (!trimmed) return null

  const parsed = parseShopUrl(trimmed)
  if (parsed) {
    return parsed.platformId === 'ldxp' ? parsed.token : null
  }

  // path-only /shop/xxx without host — do not invent a platform
  if (SHOP_PATH.test(trimmed) && !trimmed.includes('://')) {
    return null
  }

  if (TOKEN_ONLY.test(trimmed)) return trimmed
  return null
}

export function parseLdxpItemKey(url: string | null | undefined): string | null {
  if (!url) return null
  try {
    if (url.includes('://')) {
      const parsed = new URL(url)
      const hostProfile = findProfileByHost(parsed.hostname, SHOP_PROFILES)
      // Full URL: only ldxp hosts (unknown host / other platforms → null)
      if (!hostProfile || hostProfile.id !== 'ldxp') return null
      const m = parsed.pathname.match(ITEM_PATH)
      return m ? m[1] : null
    }
  } catch {
    // fall through to path regex
  }
  const m = url.match(ITEM_PATH)
  return m ? m[1] : null
}

/** Platform-aware item key extraction (any registered host). */
export function parseShopItemKey(
  input: string | null | undefined,
  profiles: readonly ShopSiteProfile[] = SHOP_PROFILES
): { platformId: string; goodsKey: string; profile: ShopSiteProfile } | null {
  if (!input) return null
  const trimmed = input.trim()
  if (!trimmed) return null
  try {
    const url = trimmed.includes('://') ? new URL(trimmed) : null
    if (!url) return null
    const profile = findProfileByHost(url.hostname, profiles)
    if (!profile) return null
    const m = url.pathname.match(ITEM_PATH)
    if (!m?.[1]) return null
    return { platformId: profile.id, goodsKey: m[1], profile }
  } catch {
    return null
  }
}
