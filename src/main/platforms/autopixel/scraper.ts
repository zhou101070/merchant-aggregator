import { AppError } from '@shared/types/errors'
import { createLogger } from '../../utils/logger'
import type { NormalizedShopProductRow } from '../../db/repositories/shop-products-repo'
import { AutopixelClient, parseAutopixelShopRef } from './client'
import { normalizeAutopixelProducts } from './normalize'

const log = createLogger('autopixel:scrape')

export async function scrapeAutopixel(options: {
  shopUrl?: string | null
  entryUrl?: string | null
  baseUrl?: string | null
  token?: string | null
  host?: string | null
  merchantId?: string | null
  shopName?: string | null
  minIntervalMs?: number
  userAgent?: string
  signal?: AbortSignal
  onProgress?: (p: { current: number; total: number; phase: string }) => void
}): Promise<{
  rows: NormalizedShopProductRow[]
  shopName: string | null
  goodsCount: number
  discoveredToken: string
}> {
  if (options.signal?.aborted) throw new AppError('CANCELLED', 'autopixel scrape cancelled')

  const ref = parseAutopixelShopRef({
    shopUrl: options.shopUrl,
    entryUrl: options.entryUrl,
    baseUrl: options.baseUrl,
    token: options.token,
    host: options.host
  })
  if (!ref) {
    throw new AppError('NOT_FOUND', 'autopixel: need shop URL path or host/slug token', {
      notFamily: true,
      platformId: 'autopixel'
    })
  }

  const client = new AutopixelClient(ref, {
    minIntervalMs: options.minIntervalMs,
    userAgent: options.userAgent,
    signal: options.signal
  })

  options.onProgress?.({ current: 0, total: 2, phase: 'discover' })
  const actionId = await client.discoverWholesaleActionId()
  if (options.signal?.aborted) throw new AppError('CANCELLED', 'autopixel scrape cancelled')

  options.onProgress?.({ current: 1, total: 2, phase: 'products' })
  const products = await client.fetchWholesaleProducts(actionId)
  if (options.signal?.aborted) throw new AppError('CANCELLED', 'autopixel scrape cancelled')

  const fetchedAt = new Date().toISOString()
  const shopName = options.shopName?.trim() || null
  const rows = normalizeAutopixelProducts(products, {
    ref,
    merchantId: options.merchantId ?? null,
    shopName,
    fetchedAt
  })

  options.onProgress?.({
    current: rows.length,
    total: Math.max(products.length, 1),
    phase: 'products'
  })

  log.info('autopixel scrape done', {
    token: ref.token,
    listed: products.length,
    kept: rows.length
  })

  return {
    rows,
    shopName,
    goodsCount: products.length,
    discoveredToken: ref.token
  }
}
