/**
 * Build shop/item URLs via shared profile registry — no host hardcodes in UI.
 */
import { SHOP_PROFILES } from '@shared/platforms/shop-profiles'
import { findProfileById, itemPageUrl, shopRootUrl } from '@shared/platforms/shop-types'

export function itemUrlForSource(
  source: string | null | undefined,
  goodsKey: string
): string | null {
  if (!source || !goodsKey) return null
  const profile = findProfileById(source, SHOP_PROFILES)
  if (!profile) return null
  return itemPageUrl(profile, goodsKey)
}

export function shopUrlForRef(platformId: string | null | undefined, token: string): string | null {
  if (!platformId || !token) return null
  const profile = findProfileById(platformId, SHOP_PROFILES)
  if (!profile) return null
  return shopRootUrl(profile, token)
}

/** Parse product id `source:token:goodsKey` or `shop:source:token:goodsKey` → item URL */
export function itemUrlFromProductId(targetId: string): string | null {
  const raw = targetId.startsWith('shop:') ? targetId.slice(5) : targetId
  const parts = raw.split(':')
  if (parts.length < 3) return null
  const source = parts[0]
  const goodsKey = parts[parts.length - 1]
  return itemUrlForSource(source, goodsKey)
}
