import { AppError } from '@shared/types/errors'
import { createLogger } from '../../utils/logger'
import { IntervalLimiter, sleep } from '../../services/rate-limiter'
import { NodebitsClient } from './client'
import {
  hasMerchantExternalLink,
  normalizeNodebitsMerchant,
  type NormalizedMerchantRow
} from './normalize'
import type { NodebitsProductRaw, NodebitsShopRaw } from './zod'

const log = createLogger('nodebits:merchants')

export interface FetchAllNodebitsMerchantsOptions {
  client?: NodebitsClient
  /** Products page size (default 100). */
  productLimit?: number
  intervalMs?: number
  signal?: AbortSignal
  onProgress?: (p: {
    phase: 'shops' | 'products' | 'normalize'
    current: number
    total: number
  }) => void
}

export interface FetchAllNodebitsMerchantsResult {
  rows: NormalizedMerchantRow[]
  /** Shops returned by /api/shops (before is_test / no-link filters) */
  shopsFetched: number
  /** Unique shop_ids seen in products */
  shopsWithProducts: number
  droppedTest: number
  droppedNoLink: number
  productPages: number
  productsFetched: number
  productsTotal: number
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new AppError('CANCELLED', 'nodebits merchants fetch cancelled')
  }
}

async function fetchAllProducts(
  client: NodebitsClient,
  opts: {
    limit: number
    intervalMs: number
    signal?: AbortSignal
    onProgress?: FetchAllNodebitsMerchantsOptions['onProgress']
  }
): Promise<{ products: NodebitsProductRaw[]; pages: number; total: number }> {
  const limiter = new IntervalLimiter(opts.intervalMs)
  const products: NodebitsProductRaw[] = []
  let offset = 0
  let total = Number.POSITIVE_INFINITY
  let pages = 0
  let consecutiveFailures = 0

  while (offset < total) {
    throwIfAborted(opts.signal)
    try {
      await limiter.waitTurn(opts.signal)
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        throw new AppError('CANCELLED', 'nodebits merchants fetch cancelled')
      }
      throw err
    }
    throwIfAborted(opts.signal)

    try {
      const page = await client.fetchProductsPage({ limit: opts.limit, offset })
      consecutiveFailures = 0
      pages += 1
      total = page.total
      products.push(...page.products)
      opts.onProgress?.({
        phase: 'products',
        current: Math.min(products.length, Number.isFinite(total) ? total : products.length),
        total: Number.isFinite(total) ? total : products.length
      })
      log.info('products page', {
        offset,
        got: page.products.length,
        total: page.total,
        accumulated: products.length
      })

      if (page.products.length === 0) break
      offset += page.products.length
      if (page.products.length < opts.limit) break
      if (Number.isFinite(total) && products.length >= total) break
    } catch (err) {
      if (err instanceof AppError && err.code === 'CANCELLED') throw err
      consecutiveFailures += 1
      if (consecutiveFailures >= 5) {
        throw err instanceof AppError
          ? err
          : new AppError('NETWORK', 'nodebits products fetch circuit open', {
              cause: String(err)
            })
      }
      const backoff = Math.min(10_000, 500 * 2 ** (consecutiveFailures - 1))
      log.warn('products page failed', {
        offset,
        consecutiveFailures,
        backoff,
        error: err instanceof Error ? err.message : String(err)
      })
      try {
        await sleep(backoff, opts.signal)
      } catch (sleepErr) {
        if (sleepErr instanceof Error && sleepErr.name === 'AbortError') {
          throw new AppError('CANCELLED', 'nodebits merchants fetch cancelled')
        }
        throw sleepErr
      }
    }
  }

  if (Number.isFinite(total) && products.length < total) {
    // Soft: products list can shrink mid-pagination; log and continue with what we have
    log.warn('products incomplete after pagination', {
      got: products.length,
      total,
      pages
    })
  }

  return {
    products,
    pages,
    total: Number.isFinite(total) ? total : products.length
  }
}

/**
 * Merchant-list pull from NodeBits (not product sync).
 * Shops + product pages → link enrichment → shared normalizeMerchant / identifyShopPlatform.
 */
export async function fetchAllNodebitsMerchants(
  options: FetchAllNodebitsMerchantsOptions = {}
): Promise<FetchAllNodebitsMerchantsResult> {
  const client = options.client ?? new NodebitsClient()
  const productLimit = options.productLimit ?? 100
  const intervalMs = options.intervalMs ?? 500

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

  const { products, pages: productPages, total: productsTotal } = await fetchAllProducts(client, {
    limit: productLimit,
    intervalMs,
    signal: options.signal,
    onProgress: options.onProgress
  })

  const byShop = new Map<string, NodebitsProductRaw[]>()
  for (const p of products) {
    const list = byShop.get(p.shop_id)
    if (list) list.push(p)
    else byShop.set(p.shop_id, [p])
  }

  const fetchedAt = new Date().toISOString()
  const generatedAt = fetchedAt
  const rows: NormalizedMerchantRow[] = []
  let droppedTest = 0
  let droppedNoLink = 0

  options.onProgress?.({
    phase: 'normalize',
    current: 0,
    total: shops.length
  })

  for (let i = 0; i < shops.length; i += 1) {
    throwIfAborted(options.signal)
    const shop = shops[i]!
    if (shop.is_test) {
      droppedTest += 1
      continue
    }
    const shopProducts = byShop.get(shop.id) ?? []
    const row = normalizeNodebitsMerchant(shop, shopProducts, { fetchedAt, generatedAt })
    if (!hasMerchantExternalLink(row)) {
      droppedNoLink += 1
      continue
    }
    rows.push(row)
    if ((i + 1) % 50 === 0 || i + 1 === shops.length) {
      options.onProgress?.({
        phase: 'normalize',
        current: i + 1,
        total: shops.length
      })
    }
  }

  log.info('nodebits merchants done', {
    shops: shops.length,
    withProducts: byShop.size,
    kept: rows.length,
    droppedTest,
    droppedNoLink,
    productPages,
    products: products.length
  })

  return {
    rows,
    shopsFetched: shops.length,
    shopsWithProducts: byShop.size,
    droppedTest,
    droppedNoLink,
    productPages,
    productsFetched: products.length,
    productsTotal
  }
}
