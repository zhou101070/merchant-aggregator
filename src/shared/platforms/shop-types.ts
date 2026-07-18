/**
 * Scrapable profile family (registered in SHOP_PROFILES).
 * Broader taxonomy (dujiao/yiciyuan/…) lives in identify.ts ShopFamilyId.
 */
export type ShopFamily = 'shopapi'

export interface ShopApiEndpoints {
  /** default '/shopApi/Shop/info' */
  info: string
  /** default '/shopApi/Shop/goodsList' */
  goodsList: string
}

export type ShopProbeStatus = 'unverified' | 'ok' | 'degraded' | 'blocked'

/**
 * Declarative site profile — single source of truth for host matching,
 * base URL, path templates, and scrape eligibility.
 *
 * Rules:
 * - No Node-only APIs (shared by main + renderer parse helpers).
 * - Adapters read fields from profile; no `profile.id === 'catfk'` branches.
 */
export interface ShopSiteProfile {
  id: string
  displayName: string
  family: ShopFamily
  hosts: readonly string[]
  baseUrl: string
  /** e.g. `/shop/{token}` */
  shopPathTemplate: string
  /** e.g. `/item/{goodsKey}` */
  itemPathTemplate: string
  /** Written to shop_products.source */
  sourceId: string
  defaultGoodsTypes: readonly string[]
  defaultMinIntervalMs: number
  /**
   * false = host is recognized but scrape is paused (PAUSED for explicit shop_one;
   * skipped in batch queues).
   */
  enabled: boolean
  endpoints?: ShopApiEndpoints
  probeStatus?: ShopProbeStatus
}

export const DEFAULT_SHOPAPI_ENDPOINTS: ShopApiEndpoints = {
  info: '/shopApi/Shop/info',
  goodsList: '/shopApi/Shop/goodsList'
}

export function shopRootUrl(
  profile: Pick<ShopSiteProfile, 'baseUrl' | 'shopPathTemplate'>,
  token: string
): string {
  return `${profile.baseUrl}${profile.shopPathTemplate.replace('{token}', token)}`
}

export function itemPageUrl(
  profile: Pick<ShopSiteProfile, 'baseUrl' | 'itemPathTemplate'>,
  goodsKey: string
): string {
  return `${profile.baseUrl}${profile.itemPathTemplate.replace('{goodsKey}', goodsKey)}`
}

export function resolveShopApiEndpoints(profile: ShopSiteProfile): ShopApiEndpoints {
  return {
    info: profile.endpoints?.info ?? DEFAULT_SHOPAPI_ENDPOINTS.info,
    goodsList: profile.endpoints?.goodsList ?? DEFAULT_SHOPAPI_ENDPOINTS.goodsList
  }
}

export function normalizeHost(host: string): string {
  return host.trim().toLowerCase().replace(/\.$/, '')
}

/** True if hostname matches profile hosts (exact or subdomain of a listed apex). */
export function hostMatchesProfile(
  hostname: string,
  profile: Pick<ShopSiteProfile, 'hosts'>
): boolean {
  const h = normalizeHost(hostname)
  for (const raw of profile.hosts) {
    const listed = normalizeHost(raw)
    if (h === listed) return true
    // allow subdomains only when listed host has no leading restriction
    if (h.endsWith(`.${listed}`)) return true
  }
  return false
}

export function findProfileByHost(
  hostname: string,
  profiles: readonly ShopSiteProfile[]
): ShopSiteProfile | null {
  const h = normalizeHost(hostname)
  for (const p of profiles) {
    if (hostMatchesProfile(h, p)) return p
  }
  return null
}

export function findProfileById(
  id: string,
  profiles: readonly ShopSiteProfile[]
): ShopSiteProfile | null {
  return profiles.find((p) => p.id === id) ?? null
}
