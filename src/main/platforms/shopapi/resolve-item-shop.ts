/**
 * shopApi item URLs (e.g. https://pay.ldxp.cn/item/5ozbbc) are product links,
 * not merchant home. Resolve via goodsInfo → shop root, then re-derive shop ref.
 * Unresolved item-only rows must be dropped (not kept as entry-only).
 *
 * Concurrency: different item hosts resolve in parallel; same host is spaced
 * by the shared process host limiter inside ShopApiClient.
 */
import { RATE_LIMITS } from '@shared/constants'
import { parseShopItemKey, parseShopUrl } from '@shared/lib/url-parse'
import { SHOP_PROFILES } from '@shared/platforms/shop-profiles'
import { findProfileById, shopRootUrl } from '@shared/platforms/shop-types'
import { AppError } from '@shared/types/errors'
import { createLogger } from '../../utils/logger'
import { mapWithConcurrency } from '../../services/rate-limiter'
import type { NormalizedMerchantRow } from '../priceai/normalize'
import { deriveShopRef } from '../priceai/normalize'
import { ShopApiClient } from './client'

const log = createLogger('shopapi:resolve-item')

export interface ResolvedItemShop {
  shopUrl: string
  token: string
  platformId: string
}

export type ItemShopResolver = (
  itemUrl: string,
  signal?: AbortSignal
) => Promise<ResolvedItemShop | null>

/** True when either URL already parses as a shopApi shop home. */
export function hasParseableShopUrl(
  shopUrl?: string | null,
  entryUrl?: string | null
): boolean {
  return !!(parseShopUrl(shopUrl) || parseShopUrl(entryUrl))
}

/** First shopApi /item/{goodsKey} among candidates (shop_url preferred). */
export function findShopApiItemUrl(
  ...urls: Array<string | null | undefined>
): string | null {
  for (const raw of urls) {
    if (!raw?.trim()) continue
    if (parseShopItemKey(raw)) return raw.trim()
  }
  return null
}

/** Rewrite merchant row with a resolved shop root and re-derive platform/token. */
export function applyResolvedShopUrl(
  row: NormalizedMerchantRow,
  resolved: ResolvedItemShop
): NormalizedMerchantRow {
  const shopUrl = resolved.shopUrl
  let host = row.host
  try {
    host = new URL(shopUrl).hostname.toLowerCase() || host
  } catch {
    /* keep prior host */
  }
  const ref = deriveShopRef({
    host,
    shopUrl,
    entryUrl: shopUrl,
    collectorKind: row.collector_kind
  })
  return {
    ...row,
    host,
    shop_url: shopUrl,
    entry_url: shopUrl,
    shop_platform: ref?.shop_platform ?? resolved.platformId,
    shop_token: ref?.shop_token ?? resolved.token,
    ldxp_token:
      ref?.ldxp_token ??
      (resolved.platformId === 'ldxp' ? resolved.token : row.ldxp_token),
    _shopRefDerived: ref != null || !!(resolved.platformId && resolved.token)
  }
}

/**
 * Default network resolver: parse item URL → profile.goodsInfo → shop root.
 * Returns null on parse miss / network / schema errors (caller drops merchant).
 */
export function createDefaultItemShopResolver(options?: {
  userAgent?: string
  minIntervalMs?: number
  /** Inject clients per platform id (tests). */
  clients?: Map<string, ShopApiClient>
}): ItemShopResolver {
  const clients = options?.clients ?? new Map<string, ShopApiClient>()
  const cache = new Map<string, ResolvedItemShop | null>()
  // Serialize in-flight resolves for the same goodsKey so concurrent callers share one request.
  const inflight = new Map<string, Promise<ResolvedItemShop | null>>()

  return async (itemUrl, signal) => {
    if (signal?.aborted) {
      throw new AppError('CANCELLED', 'item→shop resolve cancelled')
    }
    const parsed = parseShopItemKey(itemUrl)
    if (!parsed) return null

    const cacheKey = `${parsed.platformId}:${parsed.goodsKey.toLowerCase()}`
    if (cache.has(cacheKey)) return cache.get(cacheKey) ?? null

    const existing = inflight.get(cacheKey)
    if (existing) return existing

    const profile =
      findProfileById(parsed.platformId, SHOP_PROFILES) ?? parsed.profile
    let client = clients.get(profile.id)
    if (!client) {
      client = new ShopApiClient(profile, {
        userAgent: options?.userAgent,
        minIntervalMs: options?.minIntervalMs ?? profile.defaultMinIntervalMs
      })
      clients.set(profile.id, client)
    }

    const p = (async (): Promise<ResolvedItemShop | null> => {
      try {
        if (signal?.aborted) {
          throw new AppError('CANCELLED', 'item→shop resolve cancelled')
        }
        const info = await client.goodsInfo(parsed.goodsKey)
        const shopParsed = parseShopUrl(info.shopUrl)
        const token = shopParsed?.token ?? info.shopToken
        const shopUrl = shopParsed?.shopUrl ?? shopRootUrl(profile, token)
        const result: ResolvedItemShop = {
          shopUrl,
          token,
          platformId: profile.id
        }
        cache.set(cacheKey, result)
        return result
      } catch (err) {
        if (err instanceof AppError && err.code === 'CANCELLED') throw err
        log.info('item→shop resolve failed', {
          itemUrl,
          platformId: profile.id,
          goodsKey: parsed.goodsKey,
          error: err instanceof Error ? err.message : String(err)
        })
        cache.set(cacheKey, null)
        return null
      } finally {
        inflight.delete(cacheKey)
      }
    })()

    inflight.set(cacheKey, p)
    return p
  }
}

export interface ResolveMerchantItemLinksResult {
  rows: NormalizedMerchantRow[]
  /** Item-only links that failed goodsInfo / had no shop token */
  droppedItemUnresolved: number
  /** Successfully rewritten from item → shop */
  resolvedFromItem: number
}

/**
 * Keep rows that already have a shop home URL, or a non-item external link.
 * For shopApi item-only links: resolve via goodsInfo; drop if unresolved.
 * Different hosts resolve concurrently (shared host limiter inside client).
 */
export async function resolveMerchantItemLinks(
  rows: NormalizedMerchantRow[],
  options: {
    resolveItem?: ItemShopResolver
    userAgent?: string
    minIntervalMs?: number
    signal?: AbortSignal
    onProgress?: (p: { current: number; total: number }) => void
  } = {}
): Promise<ResolveMerchantItemLinksResult> {
  const resolveItem =
    options.resolveItem ??
    createDefaultItemShopResolver({
      userAgent: options.userAgent,
      minIntervalMs: options.minIntervalMs
    })

  const total = rows.length
  let droppedItemUnresolved = 0
  let resolvedFromItem = 0
  let progressDone = 0

  const mapped = await mapWithConcurrency(
    rows,
    RATE_LIMITS.maxHostParallel,
    async (row) => {
      if (options.signal?.aborted) {
        throw new AppError('CANCELLED', 'item→shop resolve cancelled')
      }

      let out: NormalizedMerchantRow | null = row
      if (hasParseableShopUrl(row.shop_url, row.entry_url)) {
        // keep
      } else {
        const itemUrl = findShopApiItemUrl(row.shop_url, row.entry_url)
        if (!itemUrl) {
          // Non-shopApi external link
        } else {
          const resolved = await resolveItem(itemUrl, options.signal)
          if (!resolved) {
            droppedItemUnresolved += 1
            out = null
          } else {
            out = applyResolvedShopUrl(row, resolved)
            resolvedFromItem += 1
          }
        }
      }

      progressDone += 1
      if (progressDone % 10 === 0 || progressDone === total) {
        options.onProgress?.({ current: progressDone, total })
      }
      return out
    },
    options.signal
  )

  const kept = mapped.filter((r): r is NormalizedMerchantRow => r != null)
  options.onProgress?.({ current: total, total })
  log.info('item→shop batch done', {
    input: total,
    kept: kept.length,
    resolvedFromItem,
    droppedItemUnresolved
  })
  return {
    rows: kept,
    droppedItemUnresolved,
    resolvedFromItem
  }
}
