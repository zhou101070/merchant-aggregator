import { AppError } from '@shared/types/errors'
import { createLogger } from '../../utils/logger'
import type { NormalizedShopProductRow } from '../../db/repositories/shop-products-repo'
import {
  DujiaoClient,
  normalizeDujiaoHost,
  resolveDujiaoBaseUrl,
  type DujiaoProduct
} from './client'
import { normalizeDujiaoProduct, normalizeDujiaoProducts, parseDujiaoGoodsKey } from './normalize'

const log = createLogger('dujiao:scrape')

export async function scrapeDujiao(options: {
  host: string
  baseUrl?: string | null
  merchantId?: string | null
  minIntervalMs?: number
  userAgent?: string
  signal?: AbortSignal
  onProgress?: (p: { current: number; total: number; phase: string }) => void
}): Promise<{ rows: NormalizedShopProductRow[]; shopName: string | null; goodsCount: number }> {
  if (options.signal?.aborted) throw new AppError('CANCELLED', 'dujiao scrape cancelled')

  const host = normalizeDujiaoHost(options.host)
  const baseUrl = resolveDujiaoBaseUrl({
    host,
    baseUrl: options.baseUrl
  })
  const client = new DujiaoClient(baseUrl, {
    minIntervalMs: options.minIntervalMs,
    userAgent: options.userAgent,
    signal: options.signal
  })

  options.onProgress?.({ current: 0, total: 1, phase: 'config' })
  const config = await client.publicConfig()
  if (options.signal?.aborted) throw new AppError('CANCELLED', 'dujiao scrape cancelled')

  const shopName = config.brand?.site_name?.trim() || null
  const currency = config.currency?.trim() || 'CNY'

  options.onProgress?.({ current: 0, total: 1, phase: 'products' })
  const products = await client.publicProducts()
  if (options.signal?.aborted) throw new AppError('CANCELLED', 'dujiao scrape cancelled')

  const fetchedAt = new Date().toISOString()
  const rows = normalizeDujiaoProducts(products, {
    host,
    baseUrl,
    merchantId: options.merchantId ?? null,
    shopName,
    currency,
    fetchedAt
  })

  options.onProgress?.({
    current: rows.length,
    total: Math.max(products.length, 1),
    phase: 'products'
  })

  log.info('dujiao scrape done', { host, baseUrl, listed: products.length, kept: rows.length })
  return { rows, shopName, goodsCount: products.length }
}

/** Fetch one product by slug and normalize (optional SKU key). */
export async function fetchDujiaoProductRows(options: {
  host: string
  baseUrl?: string | null
  goodsKey: string
  merchantId?: string | null
  shopName?: string | null
  minIntervalMs?: number
  userAgent?: string
}): Promise<NormalizedShopProductRow[]> {
  const host = normalizeDujiaoHost(options.host)
  const baseUrl = resolveDujiaoBaseUrl({ host, baseUrl: options.baseUrl })
  const { slug } = parseDujiaoGoodsKey(options.goodsKey)
  if (!slug) return []

  const client = new DujiaoClient(baseUrl, {
    minIntervalMs: options.minIntervalMs,
    userAgent: options.userAgent
  })
  let product: DujiaoProduct
  try {
    product = await client.publicProductBySlug(slug)
  } catch (err) {
    if (err instanceof AppError && err.message.includes('HTTP 404')) return []
    throw err
  }

  const config = await client.publicConfig()
  return normalizeDujiaoProduct(product, {
    host,
    baseUrl,
    merchantId: options.merchantId ?? null,
    shopName: options.shopName ?? config.brand?.site_name?.trim() ?? null,
    currency: config.currency?.trim() || 'CNY',
    fetchedAt: new Date().toISOString(),
    onlyGoodsKey: options.goodsKey
  })
}
