import { AppError } from '@shared/types/errors'
import { createLogger } from '../../utils/logger'
import type { NormalizedShopProductRow } from '../../db/repositories/shop-products-repo'
import {
  YiciyuanClient,
  normalizeYiciyuanHost,
  resolveYiciyuanBaseUrl,
  type YiciyuanCommodity
} from './client'
import { normalizeYiciyuanCommodities, normalizeYiciyuanCommodity } from './normalize'

const log = createLogger('yiciyuan:scrape')

export async function scrapeYiciyuan(options: {
  host: string
  baseUrl?: string | null
  merchantId?: string | null
  shopName?: string | null
  minIntervalMs?: number
  signal?: AbortSignal
  onProgress?: (p: { current: number; total: number; phase: string }) => void
}): Promise<{ rows: NormalizedShopProductRow[]; shopName: string | null; goodsCount: number }> {
  if (options.signal?.aborted) throw new AppError('CANCELLED', 'yiciyuan scrape cancelled')

  const host = normalizeYiciyuanHost(options.host)
  const baseUrl = resolveYiciyuanBaseUrl({
    host,
    baseUrl: options.baseUrl
  })
  const client = new YiciyuanClient(baseUrl, {
    minIntervalMs: options.minIntervalMs,
    signal: options.signal
  })

  options.onProgress?.({ current: 0, total: 1, phase: 'categories' })
  // Probe + warm path; failures mean not this family
  await client.indexData()
  if (options.signal?.aborted) throw new AppError('CANCELLED', 'yiciyuan scrape cancelled')

  options.onProgress?.({ current: 0, total: 1, phase: 'products' })
  const commodities = await client.indexCommodity()
  if (options.signal?.aborted) throw new AppError('CANCELLED', 'yiciyuan scrape cancelled')

  const fetchedAt = new Date().toISOString()
  const shopName = options.shopName?.trim() || null
  const rows = normalizeYiciyuanCommodities(commodities, {
    host,
    baseUrl,
    merchantId: options.merchantId ?? null,
    shopName,
    fetchedAt
  })

  options.onProgress?.({
    current: rows.length,
    total: Math.max(commodities.length, 1),
    phase: 'products'
  })

  log.info('yiciyuan scrape done', {
    host,
    baseUrl,
    listed: commodities.length,
    kept: rows.length
  })
  return { rows, shopName, goodsCount: commodities.length }
}

/** Refresh one product by scanning catalog (no single-item public API). */
export async function fetchYiciyuanProductRow(options: {
  host: string
  baseUrl?: string | null
  goodsKey: string
  merchantId?: string | null
  shopName?: string | null
  minIntervalMs?: number
}): Promise<NormalizedShopProductRow | null> {
  const host = normalizeYiciyuanHost(options.host)
  const baseUrl = resolveYiciyuanBaseUrl({ host, baseUrl: options.baseUrl })
  const client = new YiciyuanClient(baseUrl, { minIntervalMs: options.minIntervalMs })
  let list: YiciyuanCommodity[]
  try {
    list = await client.indexCommodity()
  } catch (err) {
    if (err instanceof AppError && err.message.includes('HTTP 404')) return null
    throw err
  }
  const hit = list.find((c) => String(c.id) === options.goodsKey)
  if (!hit) return null
  return normalizeYiciyuanCommodity(hit, {
    host,
    baseUrl,
    merchantId: options.merchantId ?? null,
    shopName: options.shopName ?? null,
    fetchedAt: new Date().toISOString(),
    onlyGoodsKey: options.goodsKey
  })
}
