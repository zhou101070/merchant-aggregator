/**
 * Build shop/item URLs via shared profile registry — no host hardcodes in UI.
 */
import { DUJIAO_PLATFORM_ID, YICIYUAN_PLATFORM_ID } from '@shared/platforms/identify'
import { dujiaoCatalogUrl, dujiaoProductPageUrl } from '@shared/platforms/dujiao-urls'
import { yiciyuanCatalogUrl, yiciyuanProductPageUrl } from '@shared/platforms/yiciyuan-urls'
import { SHOP_PROFILES } from '@shared/platforms/shop-profiles'
import { findProfileById, itemPageUrl } from '@shared/platforms/shop-types'

function itemUrlForSource(
  source: string | null | undefined,
  token: string | null | undefined,
  goodsKey: string
): string | null {
  if (!source || !goodsKey) return null
  if (source === DUJIAO_PLATFORM_ID || source === 'dujiao') {
    if (!token) return null
    return dujiaoProductPageUrl(`https://${token}`, goodsKey)
  }
  if (source === YICIYUAN_PLATFORM_ID || source === 'kami') {
    if (!token) return null
    return yiciyuanProductPageUrl(`https://${token}`, goodsKey)
  }
  const profile = findProfileById(source, SHOP_PROFILES)
  if (!profile) return null
  return itemPageUrl(profile, goodsKey)
}

/** Parse product id `source:token:goodsKey` or `shop:source:token:goodsKey` → item URL */
export function itemUrlFromProductId(targetId: string): string | null {
  const raw = targetId.startsWith('shop:') ? targetId.slice(5) : targetId
  const parts = raw.split(':')
  if (parts.length < 3) return null
  const source = parts[0]
  const token = parts[1]
  const goodsKey = parts.slice(2).join(':')
  return itemUrlForSource(source, token, goodsKey)
}

/** Merchant "打开店铺" URL — dujiao catalog is {origin}/products; yiciyuan is site root. */
export function merchantStoreUrl(m: {
  shopPlatform?: string | null
  collectorKind?: string | null
  shopUrl?: string | null
  entryUrl?: string | null
  host?: string | null
}): string | null {
  const isDujiao =
    m.shopPlatform === DUJIAO_PLATFORM_ID ||
    m.shopPlatform === 'dujiao' ||
    m.collectorKind === 'dujiao'
  if (isDujiao) {
    return dujiaoCatalogUrl(m.shopUrl || m.entryUrl, m.host)
  }
  const isYiciyuan =
    m.shopPlatform === YICIYUAN_PLATFORM_ID ||
    m.shopPlatform === 'kami' ||
    m.collectorKind === 'kami' ||
    m.collectorKind === 'yiciyuan'
  if (isYiciyuan) {
    return yiciyuanCatalogUrl(m.shopUrl || m.entryUrl, m.host)
  }
  const u = (m.shopUrl || m.entryUrl || '').trim()
  return u || null
}
