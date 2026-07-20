import { AppError } from '@shared/types/errors'
import { SHOP_API_LIMITS } from '@shared/constants'
import type { ShopSiteProfile } from '@shared/platforms/shop-types'
import { itemPageUrl } from '@shared/platforms/shop-types'
import { stripHtml } from '../../services/html-text'
import { createLogger } from '../../utils/logger'
import type { NormalizedShopProductRow } from '../../db/repositories/shop-products-repo'
import { ShopApiClient, type ShopApiGoodsItem } from './client'

const log = createLogger('shopapi:scrape')

function num(v: unknown): number | null {
  if (v == null || v === '') return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

export function normalizeGoods(
  item: ShopApiGoodsItem,
  opts: {
    profile: ShopSiteProfile
    token: string
    merchantId: string | null
    shopName: string | null
    goodsType: string
    fetchedAt: string
  }
): NormalizedShopProductRow | null {
  const key = item.goods_key
  if (!key) return null
  const stock = num(item.extend?.stock_count)
  const source = opts.profile.sourceId
  const id = `${source}:${opts.token}:${key}`
  return {
    id,
    source,
    merchant_id: opts.merchantId,
    source_shop_token: opts.token,
    source_goods_key: key,
    source_url: item.link || itemPageUrl(opts.profile, key),
    shop_name: item.user?.nickname || opts.shopName,
    title: item.name || key,
    price: num(item.price),
    market_price: num(item.market_price),
    currency: 'CNY',
    goods_type: item.goods_type || opts.goodsType,
    category_id: item.category?.id ?? null,
    category_name: item.category?.name ?? null,
    stock,
    image: item.image ?? null,
    description_text: stripHtml(item.description),
    description_html: null,
    fetched_at: opts.fetchedAt,
    raw_json: JSON.stringify(item)
  }
}

export async function scrapeShopApi(options: {
  profile: ShopSiteProfile
  token: string
  merchantId?: string | null
  minIntervalMs?: number
  /** Concurrent goodsList pages; clamped to SHOP_API_LIMITS.pageConcurrency */
  pageConcurrency?: number
  signal?: AbortSignal
  onProgress?: (p: { current: number; total: number; phase: string }) => void
}): Promise<{ rows: NormalizedShopProductRow[]; shopName: string | null; goodsCount: number }> {
  if (!options.profile.enabled) {
    throw new AppError('PAUSED', `platform ${options.profile.id} scrape disabled`, {
      platformId: options.profile.id
    })
  }

  const client = new ShopApiClient(options.profile, { minIntervalMs: options.minIntervalMs })
  const token = options.token
  if (options.signal?.aborted) throw new AppError('CANCELLED', 'shop scrape cancelled')

  await client.warmup(token)
  if (options.signal?.aborted) throw new AppError('CANCELLED', 'shop scrape cancelled')

  const info = await client.shopInfo(token)
  const types = info.goods_type_sort.length
    ? info.goods_type_sort
    : [...options.profile.defaultGoodsTypes]
  const rows: NormalizedShopProductRow[] = []
  const totalEstimate = Math.max(info.goods_count, 1)
  options.onProgress?.({ current: 0, total: totalEstimate, phase: 'info' })

  const pageSize = SHOP_API_LIMITS.defaultPageSize
  const concLim = SHOP_API_LIMITS.pageConcurrency
  const concurrency = Math.min(
    concLim.max,
    Math.max(
      concLim.min,
      Math.floor(
        typeof options.pageConcurrency === 'number' && Number.isFinite(options.pageConcurrency)
          ? options.pageConcurrency
          : concLim.default
      )
    )
  )

  for (const goodsType of types) {
    let nextPage = 1
    while (true) {
      if (options.signal?.aborted) throw new AppError('CANCELLED', 'shop scrape cancelled')
      if (nextPage > 200) {
        throw new AppError(
          'NETWORK',
          `shop pagination exceeded page 200 for goods type ${goodsType}`,
          {
            platformId: options.profile.id,
            token,
            goodsType,
            page: nextPage,
            collected: rows.length,
            goodsCount: info.goods_count
          }
        )
      }

      const batch: number[] = []
      for (let i = 0; i < concurrency && nextPage + i <= 200; i++) {
        batch.push(nextPage + i)
      }

      // allSettled: later pages may fail after we already hit a short/empty page
      const settled = await Promise.allSettled(
        batch.map(async (page) => {
          const { list } = await client.goodsList({
            token,
            goodsType,
            current: page,
            pageSize
          })
          return { page, list }
        })
      )

      let stop = false
      for (let i = 0; i < settled.length; i++) {
        const page = batch[i]
        const outcome = settled[i]
        if (outcome.status === 'rejected') {
          // Only fail if this page is still required (no earlier short/empty page)
          const err = outcome.reason
          if (err instanceof AppError) throw err
          throw new AppError('NETWORK', err instanceof Error ? err.message : String(err), {
            platformId: options.profile.id,
            token,
            goodsType,
            page
          })
        }

        const { list } = outcome.value
        if (!list.length) {
          stop = true
          break
        }
        const fetchedAt = new Date().toISOString()
        for (const item of list) {
          const row = normalizeGoods(item, {
            profile: options.profile,
            token,
            merchantId: options.merchantId ?? null,
            shopName: info.nickname,
            goodsType,
            fetchedAt
          })
          if (row) rows.push(row)
        }
        options.onProgress?.({
          current: Math.min(rows.length, totalEstimate),
          total: totalEstimate,
          phase: `goods:${goodsType}:p${page}`
        })
        if (list.length < pageSize) {
          stop = true
          break
        }
      }

      if (stop) break
      nextPage += batch.length
    }
  }

  log.info('shop scrape done', {
    platformId: options.profile.id,
    token,
    count: rows.length
  })
  return { rows, shopName: info.nickname, goodsCount: info.goods_count }
}
