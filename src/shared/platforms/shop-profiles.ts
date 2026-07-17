import type { ShopSiteProfile } from './shop-types'

/**
 * ★ Single source of truth for shop site profiles.
 * Host strings for scrape matching live ONLY here (not duplicated in main).
 * CDN hosts (qn.ldxp.cn) belong in open-external allowlist only.
 */

export const LDXP_PROFILE: ShopSiteProfile = {
  id: 'ldxp',
  displayName: '链动小铺',
  family: 'shopapi',
  hosts: ['pay.ldxp.cn', 'ldxp.cn', 'www.ldxp.cn'],
  baseUrl: 'https://pay.ldxp.cn',
  shopPathTemplate: '/shop/{token}',
  itemPathTemplate: '/item/{goodsKey}',
  sourceId: 'ldxp',
  defaultGoodsTypes: ['card', 'article', 'resource', 'equity'],
  defaultMinIntervalMs: 500,
  enabled: true,
  probeStatus: 'ok'
}

/**
 * catfk.com — shopApi-family white-label candidate (HTML shell matches ldxp).
 * Default disabled until PR6 smoke verifies Shop/info + goodsList.
 * parseShopUrl still recognizes hosts so wrong-platform attribution is fixed.
 */
export const CATFK_PROFILE: ShopSiteProfile = {
  id: 'catfk',
  displayName: 'catfk',
  family: 'shopapi',
  hosts: ['catfk.com', 'www.catfk.com'],
  baseUrl: 'https://catfk.com',
  shopPathTemplate: '/shop/{token}',
  itemPathTemplate: '/item/{goodsKey}',
  sourceId: 'catfk',
  defaultGoodsTypes: ['card', 'article', 'resource', 'equity'],
  defaultMinIntervalMs: 500,
  enabled: false,
  probeStatus: 'unverified'
}

export const SHOP_PROFILES: readonly ShopSiteProfile[] = [LDXP_PROFILE, CATFK_PROFILE]

/** Hosts that may appear on scrapable shop / item pages (from profiles). */
export function scrapableShopHosts(profiles: readonly ShopSiteProfile[] = SHOP_PROFILES): string[] {
  const set = new Set<string>()
  for (const p of profiles) {
    for (const h of p.hosts) set.add(h.toLowerCase())
  }
  return [...set]
}
