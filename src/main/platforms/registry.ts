import {
  DUJIAO_PLATFORM_ID,
  YICIYUAN_PLATFORM_ID,
  identifyShopPlatform,
  isHostTokenScrapeStrategy,
  type ShopFamilyId,
  type ShopIdentity
} from '@shared/platforms/identify'
import { SHOP_PROFILES } from '@shared/platforms/shop-profiles'
import type { ShopSiteProfile } from '@shared/platforms/shop-types'
import { findProfileById } from '@shared/platforms/shop-types'
import { hostKey } from '../services/rate-limiter'
import { scrapeShopApi } from './shopapi/scraper'
import { scrapeDujiao } from './dujiao/scraper'
import { scrapeYiciyuan } from './yiciyuan/scraper'
import { AUTOPIXEL_PLATFORM_ID } from './autopixel/client'
import { scrapeAutopixel } from './autopixel/scraper'
import type { NormalizedShopProductRow } from '../db/repositories/shop-products-repo'

export interface ShopScrapeTarget {
  platformId: string
  token: string
  merchantId: string | null
  label?: string
  /** Optional precomputed identity; when set, used for adapter dispatch. */
  identity?: ShopIdentity
  /** Absolute origin for host-as-token families (dujiao / yiciyuan). */
  baseUrl?: string | null
  /** Optional display name for host-token scrapers. */
  shopName?: string | null
  /**
   * When true, try known scrape modes in order (unknown platform strategy).
   * Also used when identity is not scrapable but host/token can be trialed.
   */
  trialUnknownPlatform?: boolean
  /** Optional URL hints for /shop/:token extraction during unknown trials. */
  shopUrl?: string | null
  entryUrl?: string | null
}

/** Formal adapter interface for shop families. */
export interface ShopScraper {
  scrape(opts: {
    target: ShopScrapeTarget
    minIntervalMs: number
    userAgent?: string
    pageConcurrency?: number
    signal?: AbortSignal
    onProgress?: (p: { current: number; total: number; phase: string }) => void
  }): Promise<{
    rows: NormalizedShopProductRow[]
    shopName: string | null
    goodsCount: number
  }>
}

function getProfile(id: string): ShopSiteProfile | null {
  return findProfileById(id, SHOP_PROFILES)
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
      userAgent: opts.userAgent,
      pageConcurrency: opts.pageConcurrency,
      signal: opts.signal,
      onProgress: opts.onProgress
    })
  }
}

const dujiaoScraper: ShopScraper = {
  async scrape(opts) {
    return scrapeDujiao({
      host: opts.target.token,
      baseUrl: opts.target.baseUrl,
      merchantId: opts.target.merchantId,
      minIntervalMs: opts.minIntervalMs,
      userAgent: opts.userAgent,
      signal: opts.signal,
      onProgress: opts.onProgress
    })
  }
}

const yiciyuanScraper: ShopScraper = {
  async scrape(opts) {
    return scrapeYiciyuan({
      host: opts.target.token,
      baseUrl: opts.target.baseUrl,
      merchantId: opts.target.merchantId,
      shopName: opts.target.shopName,
      minIntervalMs: opts.minIntervalMs,
      userAgent: opts.userAgent,
      signal: opts.signal,
      onProgress: opts.onProgress
    })
  }
}

const autopixelScraper: ShopScraper = {
  async scrape(opts) {
    const result = await scrapeAutopixel({
      shopUrl: opts.target.shopUrl,
      entryUrl: opts.target.entryUrl,
      baseUrl: opts.target.baseUrl,
      token: opts.target.token,
      merchantId: opts.target.merchantId,
      shopName: opts.target.shopName,
      minIntervalMs: opts.minIntervalMs,
      userAgent: opts.userAgent,
      signal: opts.signal,
      onProgress: opts.onProgress
    })
    return {
      rows: result.rows,
      shopName: result.shopName,
      goodsCount: result.goodsCount
    }
  }
}

function unsupportedFamilyScraper(family: ShopFamilyId): ShopScraper {
  return {
    async scrape() {
      const { AppError } = await import('@shared/types/errors')
      throw new AppError('INTERNAL', `scrape not implemented for family ${family}`, { family })
    }
  }
}

/**
 * Resolve scraper by platformId (profile registry).
 * Prefer scraperForIdentity when full merchant context is available.
 */
export function scraperFor(platformId: string): ShopScraper {
  if (platformId === DUJIAO_PLATFORM_ID) return dujiaoScraper
  if (platformId === YICIYUAN_PLATFORM_ID || platformId === 'kami') return yiciyuanScraper
  if (platformId === AUTOPIXEL_PLATFORM_ID) return autopixelScraper

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
  return unsupportedFamilyScraper(profile.family)
}

/** Dispatch by ShopIdentity.scrapeStrategy (sync entry path). */
export function scraperForIdentity(identity: ShopIdentity): ShopScraper {
  if (identity.scrapeStrategy === 'dujiao') return dujiaoScraper
  if (identity.scrapeStrategy === 'yiciyuan') return yiciyuanScraper
  if (identity.scrapeStrategy === 'autopixel') return autopixelScraper
  if (identity.scrapeStrategy === 'shopapi' && identity.platformId) {
    return scraperFor(identity.platformId)
  }
  // defensive: host-token strategy without exact branch
  if (isHostTokenScrapeStrategy(identity.scrapeStrategy) && identity.platformId) {
    return scraperFor(identity.platformId)
  }
  if (identity.scrapeStrategy === 'unsupported') {
    return unsupportedFamilyScraper(identity.family)
  }
  return {
    async scrape() {
      const { AppError } = await import('@shared/types/errors')
      throw new AppError('NOT_FOUND', identity.reason || 'merchant is not scrapable', {
        family: identity.family,
        platformId: identity.platformId
      })
    }
  }
}

export async function scrapeShopTarget(options: {
  target: ShopScrapeTarget
  minIntervalMs?: number
  userAgent?: string
  pageConcurrency?: number
  signal?: AbortSignal
  onProgress?: (p: { current: number; total: number; phase: string }) => void
}): Promise<{
  rows: NormalizedShopProductRow[]
  shopName: string | null
  goodsCount: number
  /** Set when unknown-platform trial matched a known mode */
  discoveredRef?: { platformId: string; token: string }
}> {
  const identity =
    options.target.identity ??
    identifyShopPlatform({
      shopPlatform: options.target.platformId,
      shopToken: options.target.token,
      shopUrl: options.target.shopUrl,
      entryUrl: options.target.entryUrl,
      host: options.target.token
    })

  const trial =
    options.target.trialUnknownPlatform === true ||
    (await import('./unknown-platform-scrape')).shouldTrialUnknownPlatform(identity)

  if (trial) {
    const { scrapeUnknownPlatformTrials } = await import('./unknown-platform-scrape')
    const result = await scrapeUnknownPlatformTrials({
      target: options.target,
      minIntervalMs: options.minIntervalMs ?? 500,
      userAgent: options.userAgent,
      pageConcurrency: options.pageConcurrency,
      signal: options.signal,
      onProgress: options.onProgress,
      shopUrl: options.target.shopUrl,
      entryUrl: options.target.entryUrl
    })
    return {
      rows: result.rows,
      shopName: result.shopName,
      goodsCount: result.goodsCount,
      discoveredRef: result.discoveredRef
    }
  }

  return scraperForIdentity(identity).scrape({
    target: options.target,
    minIntervalMs: options.minIntervalMs ?? 500,
    userAgent: options.userAgent,
    pageConcurrency: options.pageConcurrency,
    signal: options.signal,
    onProgress: options.onProgress
  })
}

/**
 * Host key for per-host concurrency (same host shares rate limit; different hosts independent).
 * shopApi → profile base host; host-token families → token / baseUrl host.
 */
export function scrapeTargetHostKey(target: ShopScrapeTarget): string {
  const profile = getProfile(target.platformId)
  if (profile?.baseUrl) return hostKey(profile.baseUrl)
  if (target.baseUrl) return hostKey(target.baseUrl)
  return hostKey(target.token)
}
