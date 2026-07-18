import { AppError } from '@shared/types/errors'
import { createLogger } from '../../utils/logger'
import { IntervalLimiter, sleep } from '../../services/rate-limiter'
import type { NormalizedMerchantRow } from './normalize'
import { hasMerchantExternalLink, normalizeMerchant } from './normalize'
import { PriceaiClient } from './client'
import type { PriceaiMerchantsPageParsed } from './zod'

const log = createLogger('priceai:merchants')

export interface FetchAllMerchantsOptions {
  client?: PriceaiClient
  limit?: number
  intervalMs?: number
  signal?: AbortSignal
  onProgress?: (p: { current: number; total: number; page: number }) => void
}

export interface FetchAllMerchantsResult {
  /** Merchants kept after dropping those without shop_url/entry_url */
  rows: NormalizedMerchantRow[]
  /** Unique merchant ids seen from API (before no-link drop) */
  fetchedUnique: number
  /** Dropped because both shop_url and entry_url empty */
  droppedNoLink: number
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

/**
 * Page-stop policy (must not miss tail pages):
 * 1. empty rows → end only when past total / !limited; otherwise hard-fail
 * 2. out.length >= total → done
 * 3. limited === false → done (covers exact full last page)
 * 4. short page (rows < limit) with limited still true → hard-fail
 *    (old code broke early and silently dropped remaining merchants)
 * 5. after loop, require unique count >= total when total is known
 *
 * Transport failures (network/schema/degraded) retry same offset.
 * Protocol / completeness failures fail immediately (no silent partial success).
 */
export async function fetchAllMerchants(
  options: FetchAllMerchantsOptions = {}
): Promise<FetchAllMerchantsResult> {
  const client = options.client ?? new PriceaiClient()
  const limit = options.limit ?? 100
  const limiter = new IntervalLimiter(options.intervalMs ?? 500)
  const out: NormalizedMerchantRow[] = []
  const seen = new Set<string>()
  let offset = 0
  let total = Number.POSITIVE_INFINITY
  let pages = 0
  let generatedAt: string | null = null
  let consecutiveFailures = 0

  while (offset < total) {
    throwIfAborted(options.signal)
    try {
      await limiter.waitTurn(options.signal)
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        throw new AppError('CANCELLED', 'merchants fetch cancelled')
      }
      throw err
    }
    throwIfAborted(options.signal)

    let page: PriceaiMerchantsPageParsed
    try {
      page = await client.fetchMerchantsPage({ limit, offset })
      consecutiveFailures = 0
    } catch (err) {
      if (err instanceof AppError && err.code === 'CANCELLED') throw err
      consecutiveFailures += 1
      if (consecutiveFailures >= 5) {
        throw err instanceof AppError
          ? err
          : new AppError('NETWORK', 'merchants fetch circuit open', { cause: String(err) })
      }
      const backoff = Math.min(10_000, 500 * 2 ** (consecutiveFailures - 1))
      log.warn('merchants page failed', {
        offset,
        consecutiveFailures,
        backoff,
        error: err instanceof Error ? err.message : String(err)
      })
      try {
        await sleep(backoff, options.signal)
      } catch (sleepErr) {
        if (sleepErr instanceof Error && sleepErr.name === 'AbortError') {
          throw new AppError('CANCELLED', 'merchants fetch cancelled')
        }
        throw sleepErr
      }
      continue
    }

    pages += 1
    total = page.total
    generatedAt = page.generatedAt ?? generatedAt
    const fetchedAt = new Date().toISOString()

    for (const raw of page.rows) {
      if (seen.has(raw.id)) continue
      seen.add(raw.id)
      const row = normalizeMerchant(raw, {
        fetchedAt,
        generatedAt: page.generatedAt
      })
      // 无外链丢弃；分页完整性仍按上游 unique id 计数
      if (hasMerchantExternalLink(row)) out.push(row)
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
      kept: out.length
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

  return {
    rows: out,
    fetchedUnique: unique,
    droppedNoLink: unique - out.length,
    total: Number.isFinite(total) ? total : unique,
    generatedAt,
    pages
  }
}
