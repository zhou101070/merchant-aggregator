import { SHOP_PROFILES } from '@shared/platforms/shop-profiles'
import type { ShopSiteProfile } from '@shared/platforms/shop-types'
import { findProfileByHost, findProfileById } from '@shared/platforms/shop-types'
import { scrapeShopApi } from './shopapi/scraper'
import type { NormalizedShopProductRow } from '../db/repositories/shop-products-repo'

export { SHOP_PROFILES } from '@shared/platforms/shop-profiles'
export type { ShopSiteProfile } from '@shared/platforms/shop-types'
export {
  findProfileByHost,
  findProfileById,
  shopRootUrl,
  itemPageUrl
} from '@shared/platforms/shop-types'

export function getProfile(id: string): ShopSiteProfile | null {
  return findProfileById(id, SHOP_PROFILES)
}

export function profileByHost(hostname: string): ShopSiteProfile | null {
  return findProfileByHost(hostname, SHOP_PROFILES)
}

export function enabledProfiles(): ShopSiteProfile[] {
  return SHOP_PROFILES.filter((p) => p.enabled)
}

export interface ShopScrapeTarget {
  platformId: string
  token: string
  merchantId: string | null
  label?: string
}

/** Formal adapter interface for future non-shopApi families (D11). */
export interface ShopScraper {
  scrape(opts: {
    target: ShopScrapeTarget
    minIntervalMs: number
    signal?: AbortSignal
    onProgress?: (p: { current: number; total: number; phase: string }) => void
  }): Promise<{
    rows: NormalizedShopProductRow[]
    shopName: string | null
    goodsCount: number
  }>
}

const shopApiScraper: ShopScraper = {
  async scrape(opts) {
    const profile = getProfile(opts.target.platformId)
    if (!profile) {
      const { AppError } = await import('@shared/types/errors')
      throw new AppError('NOT_FOUND', `unknown platform ${opts.target.platformId}`)
    }
    if (profile.family !== 'shopapi') {
      const { AppError } = await import('@shared/types/errors')
      throw new AppError('INTERNAL', `unsupported shop family ${profile.family}`)
    }
    return scrapeShopApi({
      profile,
      token: opts.target.token,
      merchantId: opts.target.merchantId,
      minIntervalMs: opts.minIntervalMs,
      signal: opts.signal,
      onProgress: opts.onProgress
    })
  }
}

export function scraperFor(platformId: string): ShopScraper {
  const profile = getProfile(platformId)
  if (!profile) {
    return {
      async scrape() {
        const { AppError } = await import('@shared/types/errors')
        throw new AppError('NOT_FOUND', `unknown platform ${platformId}`)
      }
    }
  }
  if (!profile.enabled) {
    return {
      async scrape() {
        const { AppError } = await import('@shared/types/errors')
        throw new AppError('PAUSED', `platform ${platformId} scrape not enabled`, {
          platformId,
          probeStatus: profile.probeStatus
        })
      }
    }
  }
  if (profile.family === 'shopapi') return shopApiScraper
  return {
    async scrape() {
      const { AppError } = await import('@shared/types/errors')
      throw new AppError('INTERNAL', `unsupported shop family ${profile.family}`)
    }
  }
}

export async function scrapeShopTarget(options: {
  target: ShopScrapeTarget
  minIntervalMs?: number
  signal?: AbortSignal
  onProgress?: (p: { current: number; total: number; phase: string }) => void
}): Promise<{ rows: NormalizedShopProductRow[]; shopName: string | null; goodsCount: number }> {
  return scraperFor(options.target.platformId).scrape({
    target: options.target,
    minIntervalMs: options.minIntervalMs ?? 500,
    signal: options.signal,
    onProgress: options.onProgress
  })
}
