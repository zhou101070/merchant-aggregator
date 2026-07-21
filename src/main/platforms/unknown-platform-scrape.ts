/**
 * Unknown-platform product sync: try existing scrape modes in order.
 * All failures → silent (caller must not blocklist / not mark failing).
 */
import { AppError } from '@shared/types/errors'
import { SHOP_PROFILES } from '@shared/platforms/shop-profiles'
import {
  DUJIAO_PLATFORM_ID,
  YICIYUAN_PLATFORM_ID,
  isHostTokenScrapeStrategy,
  isIdentityScrapable,
  type ShopIdentity
} from '@shared/platforms/identify'
import type { ShopSiteProfile } from '@shared/platforms/shop-types'
import { createLogger } from '../utils/logger'
import { hostKey } from '../services/rate-limiter'
import { scrapeDujiao } from './dujiao/scraper'
import { scrapeYiciyuan } from './yiciyuan/scraper'
import { scrapeShopApi } from './shopapi/scraper'
import {
  AUTOPIXEL_PLATFORM_ID,
  parseAutopixelShopRef
} from './autopixel/client'
import { scrapeAutopixel } from './autopixel/scraper'
import type { NormalizedShopProductRow } from '../db/repositories/shop-products-repo'
import type { ShopScrapeTarget } from './registry'

const log = createLogger('unknown-scrape')

const SHOP_PATH_TOKEN = /\/shop\/([A-Za-z0-9_.-]+)/i

export interface UnknownScrapeAttempt {
  mode: string
  ok: boolean
  message?: string
  code?: string
}

export interface UnknownScrapeResult {
  rows: NormalizedShopProductRow[]
  shopName: string | null
  goodsCount: number
  /** Confirmed platform ref to persist after success */
  discoveredRef: { platformId: string; token: string }
  attempts: UnknownScrapeAttempt[]
}

function isHostnameLike(value: string): boolean {
  const v = value.trim().toLowerCase()
  if (!v || v.includes('/') || v.includes(' ')) return false
  // host or host:port
  return v.includes('.') || /^localhost(:\d+)?$/i.test(v)
}

/** Token usable on multi-tenant shopApi profiles (not a hostname). */
export function shopApiTokenCandidate(
  target: ShopScrapeTarget,
  shopUrl?: string | null,
  entryUrl?: string | null
): string | null {
  const fromPath = (raw: string | null | undefined): string | null => {
    if (!raw?.trim()) return null
    try {
      const u = new URL(raw.trim())
      const m = u.pathname.match(SHOP_PATH_TOKEN)
      return m?.[1] ?? null
    } catch {
      const m = raw.match(SHOP_PATH_TOKEN)
      return m?.[1] ?? null
    }
  }
  const pathTok = fromPath(shopUrl) ?? fromPath(entryUrl) ?? fromPath(target.label)
  if (pathTok) return pathTok

  const raw = (target.token || '').trim()
  if (!raw) return null
  if (isHostnameLike(raw)) return null
  return raw
}

export function trialHostOf(target: ShopScrapeTarget): string | null {
  if (target.baseUrl?.trim()) {
    const h = hostKey(target.baseUrl)
    if (h && h !== '*') return h
  }
  const tok = (target.token || '').trim()
  if (tok && isHostnameLike(tok)) {
    const h = hostKey(tok)
    if (h && h !== '*') return h
  }
  return null
}

/**
 * Whether this identity should use sequential mode trials instead of a known adapter.
 * Known shopapi profiles (incl. disabled → PAUSED) must not trial.
 * Soft host-token candidates and true unknowns may trial.
 */
export function shouldTrialUnknownPlatform(identity: ShopIdentity | undefined): boolean {
  if (!identity) return true
  if (isIdentityScrapable(identity)) return false
  // Registered shopapi (enabled or paused) — use normal scraper path
  if (identity.scrapeStrategy === 'shopapi' && identity.platformId) return false
  // Soft host-token candidate (e.g. kami without fingerprint)
  if (isHostTokenScrapeStrategy(identity.scrapeStrategy) && !identity.scrapable) return true
  if (identity.scrapeStrategy === 'none' || identity.scrapeStrategy === 'unsupported') return true
  if (identity.family === 'unknown') return true
  return false
}

/** True when we have enough host/token material to attempt unknown-platform trials. */
export function canBuildUnknownTrialTarget(opts: {
  host?: string | null
  shopUrl?: string | null
  entryUrl?: string | null
  token?: string | null
  platformId?: string | null
  baseUrl?: string | null
}): boolean {
  const token = (opts.token || opts.host || '').trim()
  const baseUrl =
    opts.baseUrl?.trim() ||
    opts.shopUrl?.trim() ||
    opts.entryUrl?.trim() ||
    (opts.host?.trim() ? `https://${opts.host.trim()}` : null)
  const target: ShopScrapeTarget = {
    platformId: (opts.platformId || 'unknown').trim() || 'unknown',
    token,
    merchantId: null,
    baseUrl,
    shopUrl: opts.shopUrl,
    entryUrl: opts.entryUrl
  }
  return !!(trialHostOf(target) || shopApiTokenCandidate(target, opts.shopUrl, opts.entryUrl))
}

export function isSilentUnknownFailure(err: unknown): boolean {
  if (!(err instanceof AppError)) return false
  const details = err.details as { silentUnknown?: boolean } | undefined
  return details?.silentUnknown === true
}

function isCancelled(err: unknown): boolean {
  if (err instanceof AppError && err.code === 'CANCELLED') return true
  if (err instanceof Error && err.name === 'AbortError') return true
  return false
}

function attemptError(mode: string, err: unknown): UnknownScrapeAttempt {
  if (err instanceof AppError) {
    return { mode, ok: false, message: err.message, code: err.code }
  }
  return {
    mode,
    ok: false,
    message: err instanceof Error ? err.message : String(err)
  }
}

/**
 * Try known product-sync modes one by one against an unknown shop.
 * Order: enabled shopApi (token) → dujiao → yiciyuan → autopixel (path shop).
 * A mode only matches when it returns at least one product row — empty is not a match.
 */
export async function scrapeUnknownPlatformTrials(opts: {
  target: ShopScrapeTarget
  minIntervalMs: number
  pageConcurrency?: number
  signal?: AbortSignal
  onProgress?: (p: { current: number; total: number; phase: string }) => void
  /** Optional URL hints for /shop/:token extraction */
  shopUrl?: string | null
  entryUrl?: string | null
}): Promise<UnknownScrapeResult> {
  const { target, minIntervalMs, pageConcurrency, signal } = opts
  if (signal?.aborted) throw new AppError('CANCELLED', 'cancelled')

  const attempts: UnknownScrapeAttempt[] = []
  const host = trialHostOf(target)
  const shopApiToken = shopApiTokenCandidate(target, opts.shopUrl, opts.entryUrl)
  const enabledProfiles = SHOP_PROFILES.filter((p) => p.enabled && p.family === 'shopapi')
  const autopixelRef = parseAutopixelShopRef({
    shopUrl: opts.shopUrl ?? target.shopUrl,
    entryUrl: opts.entryUrl ?? target.entryUrl,
    baseUrl: target.baseUrl,
    token: target.token,
    host
  })

  const modes: {
    mode: string
    platformId: string
    token: string
    run: () => Promise<{
      rows: NormalizedShopProductRow[]
      shopName: string | null
      goodsCount: number
      tokenOverride?: string
    }>
  }[] = []

  if (shopApiToken) {
    for (const profile of enabledProfiles) {
      modes.push({
        mode: `shopapi:${profile.id}`,
        platformId: profile.id,
        token: shopApiToken,
        run: () =>
          scrapeShopApi({
            profile: profile as ShopSiteProfile,
            token: shopApiToken,
            merchantId: target.merchantId,
            minIntervalMs,
            pageConcurrency,
            signal,
            onProgress: opts.onProgress
          })
      })
    }
  }

  if (host) {
    const baseUrl = target.baseUrl ?? `https://${host}`
    modes.push({
      mode: 'dujiao',
      platformId: DUJIAO_PLATFORM_ID,
      token: host,
      run: () =>
        scrapeDujiao({
          host,
          baseUrl,
          merchantId: target.merchantId,
          minIntervalMs,
          signal,
          onProgress: opts.onProgress
        })
    })
    modes.push({
      mode: 'yiciyuan',
      platformId: YICIYUAN_PLATFORM_ID,
      token: host,
      run: () =>
        scrapeYiciyuan({
          host,
          baseUrl,
          merchantId: target.merchantId,
          shopName: target.shopName,
          minIntervalMs,
          signal,
          onProgress: opts.onProgress
        })
    })
  }

  if (autopixelRef) {
    modes.push({
      mode: 'autopixel',
      platformId: AUTOPIXEL_PLATFORM_ID,
      token: autopixelRef.token,
      run: async () => {
        const result = await scrapeAutopixel({
          shopUrl: opts.shopUrl ?? target.shopUrl ?? autopixelRef.shopPageUrl,
          entryUrl: opts.entryUrl ?? target.entryUrl,
          baseUrl: target.baseUrl ?? autopixelRef.baseUrl,
          token: autopixelRef.token,
          merchantId: target.merchantId,
          shopName: target.shopName,
          minIntervalMs,
          signal,
          onProgress: opts.onProgress
        })
        return {
          rows: result.rows,
          shopName: result.shopName,
          goodsCount: result.goodsCount,
          tokenOverride: result.discoveredToken
        }
      }
    })
  }

  if (!modes.length) {
    throw new AppError('NOT_FOUND', 'unknown platform: no host or shop token to trial', {
      silentUnknown: true,
      attempts
    })
  }

  for (const m of modes) {
    if (signal?.aborted) throw new AppError('CANCELLED', 'cancelled')
    opts.onProgress?.({
      current: 0,
      total: 1,
      phase: `trial:${m.mode}`
    })
    try {
      const result = await m.run()
      // Empty catalog is not a family match — continue trials (no false lock-in).
      if (!result.rows.length) {
        attempts.push({
          mode: m.mode,
          ok: false,
          message: 'empty catalog',
          code: 'NOT_FOUND'
        })
        log.info('unknown platform trial empty (not a match)', {
          mode: m.mode,
          goodsCount: result.goodsCount
        })
        continue
      }
      const token = result.tokenOverride ?? m.token
      attempts.push({ mode: m.mode, ok: true })
      log.info('unknown platform trial matched', {
        mode: m.mode,
        platformId: m.platformId,
        token,
        goodsCount: result.goodsCount,
        rows: result.rows.length
      })
      return {
        rows: result.rows,
        shopName: result.shopName,
        goodsCount: result.goodsCount,
        discoveredRef: { platformId: m.platformId, token },
        attempts
      }
    } catch (err) {
      if (isCancelled(err)) throw err
      const a = attemptError(m.mode, err)
      attempts.push(a)
      log.info('unknown platform trial miss', {
        mode: m.mode,
        message: a.message,
        code: a.code
      })
    }
  }

  throw new AppError('NOT_FOUND', 'unknown platform: all scrape modes failed', {
    silentUnknown: true,
    attempts
  })
}
