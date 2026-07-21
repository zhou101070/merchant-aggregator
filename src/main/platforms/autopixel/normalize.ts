import type { NormalizedShopProductRow } from '../../db/repositories/shop-products-repo'
import {
  AUTOPIXEL_SOURCE_ID,
  type AutopixelProduct,
  type AutopixelShopRef
} from './client'

function num(v: unknown): number {
  if (v == null || v === '') return 0
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}

function numOrNull(v: unknown): number | null {
  if (v == null || v === '') return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

/** Wholesale channel: skip archived / wholesale-disabled. */
export function isAutopixelProductListed(p: AutopixelProduct): boolean {
  if (p.is_archived === true) return false
  if (p.is_wholesale_active === false) return false
  return true
}

export function productPrice(p: AutopixelProduct): number | null {
  const w = numOrNull(p.wholesale_price)
  if (w != null && w > 0) return w
  return numOrNull(p.price)
}

export function productMarketPrice(p: AutopixelProduct): number | null {
  const retail = numOrNull(p.price)
  const wholesale = numOrNull(p.wholesale_price)
  if (retail != null && wholesale != null && retail > wholesale) return retail
  return null
}

export function productStock(p: AutopixelProduct): number {
  return Math.max(0, num(p.stock_count))
}

export function goodsKeyOf(p: AutopixelProduct): string | null {
  if (p.id == null || p.id === '') return null
  return String(p.id)
}

export function normalizeAutopixelProduct(
  product: AutopixelProduct,
  opts: {
    ref: AutopixelShopRef
    merchantId: string | null
    shopName: string | null
    currency?: string
    fetchedAt: string
    onlyGoodsKey?: string | null
  }
): NormalizedShopProductRow | null {
  const goodsKey = goodsKeyOf(product)
  if (!goodsKey) return null
  if (opts.onlyGoodsKey && opts.onlyGoodsKey !== goodsKey) return null
  if (!isAutopixelProductListed(product)) return null

  const title =
    product.wholesale_name?.trim() || product.name?.trim() || null
  if (!title) return null

  const stock = productStock(product)
  const price = productPrice(product)
  const marketPrice = productMarketPrice(product)
  const categoryName = product.category?.trim() || null
  const image = product.image_url?.trim() || null
  const desc =
    product.wholesale_description?.trim() || product.description?.trim() || null
  const goodsType = product.delivery_type?.trim() || 'card'

  return {
    id: `${AUTOPIXEL_SOURCE_ID}:${opts.ref.token}:${goodsKey}`,
    source: AUTOPIXEL_SOURCE_ID,
    merchant_id: opts.merchantId,
    source_shop_token: opts.ref.token,
    source_goods_key: goodsKey,
    source_url: opts.ref.shopPageUrl,
    shop_name: opts.shopName,
    title,
    price,
    market_price: marketPrice,
    currency: opts.currency ?? 'CNY',
    goods_type: goodsType,
    category_id: null,
    category_name: categoryName,
    stock,
    image,
    description_text: desc,
    description_html: null,
    fetched_at: opts.fetchedAt,
    raw_json: JSON.stringify(product)
  }
}

export function normalizeAutopixelProducts(
  list: AutopixelProduct[],
  opts: {
    ref: AutopixelShopRef
    merchantId: string | null
    shopName: string | null
    currency?: string
    fetchedAt: string
  }
): NormalizedShopProductRow[] {
  const rows: NormalizedShopProductRow[] = []
  for (const p of list) {
    const row = normalizeAutopixelProduct(p, opts)
    if (row) rows.push(row)
  }
  return rows
}
