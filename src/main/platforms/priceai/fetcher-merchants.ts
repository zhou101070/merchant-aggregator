import { AppError } from '@shared/types/errors'
import { createLogger } from '../../utils/logger'
import {
  findShopApiItemUrl,
  hasParseableShopUrl,
  resolveMerchantItemLinks,
  type ItemShopResolver
} from '../shopapi/resolve-item-shop'
import type { NormalizedMerchantRow } from './normalize'
import { hasMerchantExternalLink, normalizeMerchant } from './normalize'
import { PriceaiClient } from './client'

const log = createLogger('priceai:merchants')

export interface FetchAllMerchantsOptions {
  client?: PriceaiClient
  limit?: number
  intervalMs?: number
  signal?: AbortSignal
  userAgent?: string
  /** Inject item→shop resolver (tests); default hits shopApi goodsInfo. */
  resolveItem?: ItemShopResolver
  /**
   * Called as soon as merchants are ready to persist (per page: immediate
   * shop-home rows first, then item→shop resolved rows). Prefer this over
   * waiting for the final result when writing to the DB.
   */
  onMerchantsReady?: (rows: NormalizedMerchantRow[]) => void
  onProgress?: (p: {
    current: number
    total: number
    page: number
    phase?: 'pages' | 'resolve'
  }) => void
}

export interface FetchAllMerchantsResult {
  /** Merchants kept after dropping those without shop_url/entry_url */
  rows: NormalizedMerchantRow[]
  /** Unique merchant ids seen from API (before no-link drop) */
  fetchedUnique: number
  /** Dropped because both shop_url and entry_url empty, or item→shop failed */
  droppedNoLink: number
  droppedItemUnresolved: number
  resolvedFromItem: number
  /** Upstream page.total when known */
  total: number
  generatedAt: string | null
  pages: number
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new AppError('CANCELLED', 'merchants fetch cancelled')
  }
}

/** Rows that already have a usable shop home / non-item external link. */
function isReadyWithoutItemResolve(row: NormalizedMerchantRow): boolean {
  return (
    hasParseableShopUrl(row.shop_url, row.entry_url) ||
    !findShopApiItemUrl(row.shop_url, row.entry_url)
  )
}

/**
 * Page-stop policy (must not miss tail pages):
 * 1. empty rows → end only when past total / !limited; otherwise hard-fail
 * 2. out.length >= total → done
 * 3. limited === false → done (covers exact full last page)
 * 4. short page (rows < limit) with limited still true → hard-fail
 *    (old code broke early and silently dropped remaining merchants)
 * 5. after loop, require unique count >= total when total is known
 *
 * Transport retry is owned by HttpClient. This layer never retries an offset,
 * preventing pagination and transport retry multiplication.
 *
 * Persistence: each page flushes ready rows via onMerchantsReady before the
 * next page is requested (item-only rows flush after goodsInfo resolve).
 */
export async function fetchAllMerchants(
  options: FetchAllMerchantsOptions = {}
): Promise<FetchAllMerchantsResult> {
  const client =
    options.client ??
    new PriceaiClient({ userAgent: options.userAgent, minIntervalMs: options.intervalMs })
  const limit = options.limit ?? 100
  const out: NormalizedMerchantRow[] = []
  const seen = new Set<string>()
  let offset = 0
  let total = Number.POSITIVE_INFINITY
  let pages = 0
  let generatedAt: string | null = null
  let emptyLinkDropped = 0
  let droppedItemUnresolved = 0
  let resolvedFromItem = 0

  while (offset < total) {
    throwIfAborted(options.signal)

    const page = await client.fetchMerchantsPage({
      limit,
      offset,
      ...(options.signal ? { signal: options.signal } : {})
    })

    pages += 1
    total = page.total
    generatedAt = page.generatedAt ?? generatedAt
    const fetchedAt = new Date().toISOString()

    const pageLinked: NormalizedMerchantRow[] = []
    for (const raw of page.rows) {
      if (seen.has(raw.id)) continue
      seen.add(raw.id)
      const row = normalizeMerchant(raw, {
        fetchedAt,
        generatedAt: page.generatedAt
      })
      // 无外链丢弃；分页完整性仍按上游 unique id 计数
      if (hasMerchantExternalLink(row)) pageLinked.push(row)
      else emptyLinkDropped += 1
    }

    // Flush shop-home / non-item rows immediately; item-only after goodsInfo.
    const immediate: NormalizedMerchantRow[] = []
    const needItem: NormalizedMerchantRow[] = []
    for (const row of pageLinked) {
      if (isReadyWithoutItemResolve(row)) immediate.push(row)
      else needItem.push(row)
    }

    if (immediate.length) {
      out.push(...immediate)
      options.onMerchantsReady?.(immediate)
    }

    let flushedResolved = 0
    if (needItem.length) {
      const resolved = await resolveMerchantItemLinks(needItem, {
        resolveItem: options.resolveItem,
        userAgent: options.userAgent,
        minIntervalMs: options.intervalMs,
        signal: options.signal,
        onProgress: (p) =>
          options.onProgress?.({
            current: Math.min(
              seen.size - needItem.length + p.current,
              Number.isFinite(total) ? total : seen.size
            ),
            total: Number.isFinite(total) ? total : seen.size,
            page: pages,
            phase: 'resolve'
          })
      })
      droppedItemUnresolved += resolved.droppedItemUnresolved
      resolvedFromItem += resolved.resolvedFromItem
      flushedResolved = resolved.rows.length
      if (resolved.rows.length) {
        out.push(...resolved.rows)
        options.onMerchantsReady?.(resolved.rows)
      }
    }

    const unique = seen.size
    options.onProgress?.({
      current: Math.min(unique, Number.isFinite(total) ? total : unique),
      total: Number.isFinite(total) ? total : unique,
      page: pages
    })

    log.info('merchants page', {
      offset,
      got: page.rows.length,
      total: page.total,
      limited: page.limited,
      unique,
      kept: out.length,
      flushedImmediate: immediate.length,
      flushedResolved
    })

    // --- stop / continue (protocol checks: no silent early exit) ---
    if (page.rows.length === 0) {
      if (page.limited && Number.isFinite(total) && unique < total) {
        throw new AppError(
          'NETWORK',
          `merchants empty page before total exhausted (got ${unique}/${total})`,
          { offset, total, limited: page.limited }
        )
      }
      break
    }

    if (Number.isFinite(total) && unique >= total) {
      break
    }

    // limited=false means "no further pages" (incl. exact full last page)
    if (!page.limited) {
      break
    }

    // Short page while API still says more remain — old code `break` here
    // and silently dropped the tail. Fail loud instead.
    if (page.rows.length < limit) {
      throw new AppError(
        'NETWORK',
        `merchants short page while limited=true (got ${unique}/${total}, page=${page.rows.length}, limit=${limit})`,
        {
          offset,
          total,
          limited: page.limited,
          pageRows: page.rows.length,
          limit
        }
      )
    }

    offset += page.rows.length
  }

  const unique = seen.size
  if (Number.isFinite(total) && unique < total) {
    throw new AppError(
      'NETWORK',
      `merchants incomplete after pagination: got ${unique}/${total} (pages=${pages})`,
      { got: unique, total, pages, offset }
    )
  }

  log.info('merchants done', {
    kept: out.length,
    droppedItemUnresolved,
    resolvedFromItem,
    emptyLinkDropped
  })

  return {
    rows: out,
    fetchedUnique: unique,
    droppedNoLink: emptyLinkDropped + droppedItemUnresolved,
    droppedItemUnresolved,
    resolvedFromItem,
    total: Number.isFinite(total) ? total : unique,
    generatedAt,
    pages
  }
}
