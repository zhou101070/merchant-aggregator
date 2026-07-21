import { RATE_LIMITS } from '@shared/constants'
import { AppError } from '@shared/types/errors'
import { createLogger } from '../../utils/logger'
import { mapWithConcurrency } from '../../services/rate-limiter'
import {
  createDefaultItemShopResolver,
  resolveMerchantItemLinks,
  type ItemShopResolver
} from '../shopapi/resolve-item-shop'
import { NodebitsClient } from './client'
import {
  hasMerchantExternalLink,
  normalizeNodebitsMerchant,
  type NormalizedMerchantRow
} from './normalize'
import type { NodebitsShopRaw } from './zod'

const log = createLogger('nodebits:merchants')

export interface FetchAllNodebitsMerchantsOptions {
  client?: NodebitsClient
  intervalMs?: number
  signal?: AbortSignal
  userAgent?: string
  /** Inject item→shop resolver (tests); default hits shopApi goodsInfo. */
  resolveItem?: ItemShopResolver
  /**
   * Inject per-shop go resolver (tests). Default: client.fetchShopGoTarget.
   * Return external shop URL or null.
   */
  resolveShopGo?: (shopId: string, signal?: AbortSignal) => Promise<string | null>
  /**
   * Called as soon as each merchant is fully ready (after /go + optional
   * item→shop resolve). Prefer this for DB writes during the pull.
   */
  onMerchantsReady?: (rows: NormalizedMerchantRow[]) => void
  onProgress?: (p: {
    phase: 'shops' | 'go' | 'normalize' | 'resolve'
    current: number
    total: number
  }) => void
}

export interface FetchAllNodebitsMerchantsResult {
  rows: NormalizedMerchantRow[]
  /** Shops returned by /api/shops (before is_test / no-link filters) */
  shopsFetched: number
  /** Non-test shops for which /go returned a parseable external URL */
  goResolved: number
  /** Non-test shops where /go failed or returned nothing useful */
  goFailed: number
  droppedTest: number
  droppedNoLink: number
  /** shopApi item links that failed goodsInfo → shop */
  droppedItemUnresolved: number
  resolvedFromItem: number
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new AppError('CANCELLED', 'nodebits merchants fetch cancelled')
  }
}

/**
 * Merchant-list pull from NodeBits (not product sync).
 *
 * Flow:
 * 1. GET /api/shops → ids + names
 * 2. For each non-test shop: GET /go?type=shop&id=… → external URL
 *    (host-limited on nodebits; other hosts never share this lane)
 * 3. normalizeMerchant / identifyShopPlatform
 * 4. shopApi /item/… → goodsInfo shop root (or drop) — per-host parallel
 * 5. onMerchantsReady per merchant as soon as it is ready (streaming write)
 */
export async function fetchAllNodebitsMerchants(
  options: FetchAllNodebitsMerchantsOptions = {}
): Promise<FetchAllNodebitsMerchantsResult> {
  const client = options.client ?? new NodebitsClient({ userAgent: options.userAgent })
  const intervalMs = options.intervalMs ?? RATE_LIMITS.priceaiMerchantsIntervalMs.default
  const resolveShopGo =
    options.resolveShopGo ??
    ((shopId: string, signal?: AbortSignal) => client.fetchShopGoTarget(shopId, signal))
  // Shared resolver so concurrent workers reuse goodsInfo cache / inflight.
  const resolveItem =
    options.resolveItem ??
    createDefaultItemShopResolver({
      userAgent: options.userAgent,
      minIntervalMs: intervalMs
    })

  throwIfAborted(options.signal)
  options.onProgress?.({ phase: 'shops', current: 0, total: 1 })

  let shops: NodebitsShopRaw[]
  try {
    shops = await client.fetchShops()
  } catch (err) {
    if (err instanceof AppError && err.code === 'CANCELLED') throw err
    throw err instanceof AppError
      ? err
      : new AppError('NETWORK', 'nodebits shops fetch failed', { cause: String(err) })
  }
  options.onProgress?.({ phase: 'shops', current: 1, total: 1 })
  log.info('shops fetched', { count: shops.length })

  const fetchedAt = new Date().toISOString()
  const generatedAt = fetchedAt
  let droppedTest = 0
  let droppedNoLink = 0
  let goResolved = 0
  let goFailed = 0
  let goDone = 0
  let droppedItemUnresolved = 0
  let resolvedFromItem = 0

  const work = shops.filter((s) => {
    if (s.is_test) {
      droppedTest += 1
      return false
    }
    return true
  })

  const parallel = RATE_LIMITS.maxHostParallel
  const goResults = await mapWithConcurrency(
    work,
    parallel,
    async (shop) => {
      throwIfAborted(options.signal)
      let externalUrl: string | null = null
      try {
        externalUrl = await resolveShopGo(shop.id, options.signal)
      } catch (err) {
        if (err instanceof AppError && err.code === 'CANCELLED') throw err
        if (err instanceof Error && err.name === 'AbortError') {
          throw new AppError('CANCELLED', 'nodebits merchants fetch cancelled')
        }
        log.info('go resolve error', {
          shopId: shop.id,
          error: err instanceof Error ? err.message : String(err)
        })
        externalUrl = null
      }

      if (externalUrl) goResolved += 1
      else goFailed += 1
      goDone += 1
      if (goDone % 20 === 0 || goDone === work.length) {
        options.onProgress?.({
          phase: 'go',
          current: goDone,
          total: work.length
        })
      }

      const row = normalizeNodebitsMerchant(shop, {
        fetchedAt,
        generatedAt,
        externalUrl
      })
      if (!hasMerchantExternalLink(row)) {
        droppedNoLink += 1
        return null
      }

      // Item→shop if needed, then flush immediately (do not wait for other shops).
      const resolved = await resolveMerchantItemLinks([row], {
        resolveItem,
        userAgent: options.userAgent,
        minIntervalMs: intervalMs,
        signal: options.signal,
        onProgress: () =>
          options.onProgress?.({
            phase: 'resolve',
            current: goDone,
            total: work.length
          })
      })
      droppedItemUnresolved += resolved.droppedItemUnresolved
      resolvedFromItem += resolved.resolvedFromItem
      if (resolved.droppedItemUnresolved) {
        droppedNoLink += 1
        return null
      }
      const ready = resolved.rows[0]
      if (!ready) return null
      options.onMerchantsReady?.([ready])
      return ready
    },
    options.signal
  )

  const kept = goResults.filter((r): r is NormalizedMerchantRow => r != null)

  options.onProgress?.({
    phase: 'normalize',
    current: work.length,
    total: work.length
  })

  log.info('nodebits merchants done', {
    shops: shops.length,
    goResolved,
    goFailed,
    kept: kept.length,
    droppedTest,
    droppedNoLink,
    droppedItemUnresolved,
    resolvedFromItem
  })

  return {
    rows: kept,
    shopsFetched: shops.length,
    goResolved,
    goFailed,
    droppedTest,
    droppedNoLink,
    droppedItemUnresolved,
    resolvedFromItem
  }
}
