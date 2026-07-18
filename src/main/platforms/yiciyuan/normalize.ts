import { yiciyuanProductPageUrl } from '@shared/platforms/yiciyuan-urls'
import type { NormalizedShopProductRow } from '../../db/repositories/shop-products-repo'
import { YICIYUAN_SOURCE_ID, type YiciyuanCommodity } from './client'

function num(v: unknown): number {
  if (v == null || v === '') return 0
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}

function resolveImage(baseUrl: string, cover: string | null | undefined): string | null {
  const t = cover?.trim()
  if (!t) return null
  if (t.startsWith('http://') || t.startsWith('https://')) return t
  if (t.startsWith('//')) return `https:${t}`
  if (t.startsWith('/')) return `${baseUrl.replace(/\/$/, '')}${t}`
  return `${baseUrl.replace(/\/$/, '')}/${t}`
}

/** Visible + in stock. */
export function isYiciyuanCommodityListed(c: YiciyuanCommodity): boolean {
  if (c.status != null && Number(c.status) !== 1) return false
  if (c.hide != null && Number(c.hide) === 1) return false
  return commodityStock(c) > 0
}

export function commodityStock(c: YiciyuanCommodity): number {
  return Math.max(0, num(c.stock))
}

export function commodityPrice(c: YiciyuanCommodity): number | null {
  const raw = c.user_price ?? c.price
  if (raw == null || raw === '') return null
  const n = Number(raw)
  return Number.isFinite(n) ? n : null
}

export function goodsKeyOf(c: YiciyuanCommodity): string | null {
  if (c.id == null || c.id === '') return null
  return String(c.id)
}

export function normalizeYiciyuanCommodity(
  commodity: YiciyuanCommodity,
  opts: {
    host: string
    baseUrl: string
    merchantId: string | null
    shopName: string | null
    currency?: string
    fetchedAt: string
    onlyGoodsKey?: string | null
  }
): NormalizedShopProductRow | null {
  const goodsKey = goodsKeyOf(commodity)
  if (!goodsKey) return null
  if (opts.onlyGoodsKey && opts.onlyGoodsKey !== goodsKey) return null
  if (!isYiciyuanCommodityListed(commodity)) return null

  const title = commodity.name?.trim()
  if (!title) return null

  const stock = commodityStock(commodity)
  const price = commodityPrice(commodity)
  const categoryName = commodity.category?.name?.trim() || null
  const categoryIdRaw = commodity.category_id ?? commodity.category?.id
  const categoryId =
    categoryIdRaw != null && categoryIdRaw !== '' && Number.isFinite(Number(categoryIdRaw))
      ? Number(categoryIdRaw)
      : null
  const image = resolveImage(opts.baseUrl, commodity.cover)
  const sourceUrl = yiciyuanProductPageUrl(opts.baseUrl, goodsKey)
  const goodsType = commodity.delivery_way != null ? `delivery_${commodity.delivery_way}` : 'card'

  return {
    id: `${YICIYUAN_SOURCE_ID}:${opts.host}:${goodsKey}`,
    source: YICIYUAN_SOURCE_ID,
    merchant_id: opts.merchantId,
    source_shop_token: opts.host,
    source_goods_key: goodsKey,
    source_url: sourceUrl,
    shop_name: opts.shopName,
    title,
    price,
    market_price: null,
    currency: opts.currency ?? 'CNY',
    goods_type: goodsType,
    category_id: categoryId,
    category_name: categoryName,
    stock,
    image,
    description_text: null,
    description_html: null,
    fetched_at: opts.fetchedAt,
    raw_json: JSON.stringify(commodity)
  }
}

export function normalizeYiciyuanCommodities(
  list: YiciyuanCommodity[],
  opts: {
    host: string
    baseUrl: string
    merchantId: string | null
    shopName: string | null
    currency?: string
    fetchedAt: string
  }
): NormalizedShopProductRow[] {
  const rows: NormalizedShopProductRow[] = []
  for (const c of list) {
    const row = normalizeYiciyuanCommodity(c, opts)
    if (row) rows.push(row)
  }
  return rows
}
