import { dujiaoProductPageUrl } from '@shared/platforms/dujiao-urls'
import { stripHtml } from '../../services/html-text'
import type { NormalizedShopProductRow } from '../../db/repositories/shop-products-repo'
import {
  DUJIAO_SOURCE_ID,
  type DujiaoI18n,
  type DujiaoProduct,
  type DujiaoSku
} from './client'

function num(v: unknown): number {
  if (v == null || v === '') return 0
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}

export function pickI18n(obj: DujiaoI18n | Record<string, string> | null | undefined): string {
  if (!obj || typeof obj !== 'object') return ''
  const o = obj as Record<string, string | undefined>
  const preferred = o['zh-CN'] || o['zh-TW'] || o['en-US']
  if (preferred?.trim()) return preferred.trim()
  for (const v of Object.values(o)) {
    if (typeof v === 'string' && v.trim()) return v.trim()
  }
  return ''
}

function resolveImage(baseUrl: string, images: string[] | null | undefined): string | null {
  const first = images?.find((x) => typeof x === 'string' && x.trim())
  if (!first) return null
  const t = first.trim()
  if (t.startsWith('http://') || t.startsWith('https://')) return t
  if (t.startsWith('//')) return `https:${t}`
  if (t.startsWith('/')) return `${baseUrl.replace(/\/$/, '')}${t}`
  return `${baseUrl.replace(/\/$/, '')}/${t}`
}

function skuStock(sku: DujiaoSku): number {
  let s =
    num(sku.auto_stock_available) + num(sku.manual_stock_available) + num(sku.upstream_stock)
  if (s <= 0 && sku.manual_stock_total != null) {
    s = Math.max(0, num(sku.manual_stock_total) - num(sku.manual_stock_sold))
  }
  return s
}

export function productStock(p: DujiaoProduct): number {
  const top = num(p.auto_stock_available) + num(p.manual_stock_available)
  if (top > 0) return top
  let sum = 0
  for (const sku of p.skus ?? []) {
    if (sku.is_active === false) continue
    sum += skuStock(sku)
  }
  return sum
}

function skuLabel(sku: DujiaoSku): string {
  const fromSpec = pickI18n(sku.spec_values as DujiaoI18n | undefined)
  if (fromSpec) return fromSpec
  const code = sku.sku_code?.trim()
  if (code && code.toLowerCase() !== 'default' && code.toLowerCase() !== 'sku-1') return code
  return ''
}

function activeSkus(p: DujiaoProduct): DujiaoSku[] {
  const list = p.skus ?? []
  return list.filter((s) => s.is_active !== false)
}

export function parseDujiaoGoodsKey(goodsKey: string): { slug: string; skuId: string | null } {
  const idx = goodsKey.indexOf('#')
  if (idx < 0) return { slug: goodsKey, skuId: null }
  return { slug: goodsKey.slice(0, idx), skuId: goodsKey.slice(idx + 1) || null }
}

export function normalizeDujiaoProduct(
  product: DujiaoProduct,
  opts: {
    host: string
    baseUrl: string
    merchantId: string | null
    shopName: string | null
    currency: string
    fetchedAt: string
    /** When set, only emit the matching SKU row (stock refresh). */
    onlyGoodsKey?: string | null
  }
): NormalizedShopProductRow[] {
  const slug = (product.slug ?? (product.id != null ? String(product.id) : '')).trim()
  if (!slug) return []
  if (product.is_sold_out === true && productStock(product) <= 0) return []

  const baseTitle = pickI18n(product.title) || slug
  const categoryName = pickI18n(product.category?.name) || null
  const categoryId =
    typeof product.category_id === 'number'
      ? product.category_id
      : typeof product.category?.id === 'number'
        ? product.category.id
        : null
  const image = resolveImage(opts.baseUrl, product.images)
  const descriptionHtml = pickI18n(product.content) || null
  const descriptionText =
    stripHtml(descriptionHtml) || stripHtml(pickI18n(product.description)) || null
  const goodsType = product.fulfillment_type?.trim() || 'dujiao'
  const sourceUrl = dujiaoProductPageUrl(opts.baseUrl, slug)
  const host = opts.host
  const skus = activeSkus(product)
  const multi = skus.length > 1

  const emit = (
    goodsKey: string,
    title: string,
    price: number | null,
    stock: number,
    raw: unknown
  ): NormalizedShopProductRow | null => {
    if (opts.onlyGoodsKey && opts.onlyGoodsKey !== goodsKey) return null
    if (!(stock > 0)) return null
    return {
      id: `${DUJIAO_SOURCE_ID}:${host}:${goodsKey}`,
      source: DUJIAO_SOURCE_ID,
      merchant_id: opts.merchantId,
      source_shop_token: host,
      source_goods_key: goodsKey,
      source_url: sourceUrl,
      shop_name: opts.shopName,
      title,
      price,
      market_price: null,
      currency: opts.currency,
      goods_type: goodsType,
      category_id: categoryId,
      category_name: categoryName,
      stock,
      image,
      description_text: descriptionText,
      description_html: descriptionHtml,
      fetched_at: opts.fetchedAt,
      raw_json: JSON.stringify(raw)
    }
  }

  const rows: NormalizedShopProductRow[] = []

  if (multi) {
    for (const sku of skus) {
      const skuId = sku.id != null ? String(sku.id) : sku.sku_code?.trim() || ''
      if (!skuId) continue
      const goodsKey = `${slug}#${skuId}`
      const label = skuLabel(sku)
      const title = label ? `${baseTitle} · ${label}` : baseTitle
      const priceRaw = sku.price_amount ?? product.price_amount
      const price = priceRaw == null || priceRaw === '' ? null : num(priceRaw)
      const stock = skuStock(sku)
      const row = emit(goodsKey, title, price, stock, { product, sku })
      if (row) rows.push(row)
    }
    return rows
  }

  // Single SKU or no SKU array: product-level row
  const stock = productStock(product)
  const priceRaw = product.price_amount ?? skus[0]?.price_amount
  const price = priceRaw == null || priceRaw === '' ? null : num(priceRaw)
  const row = emit(slug, baseTitle, price, stock, product)
  if (row) rows.push(row)
  return rows
}

export function normalizeDujiaoProducts(
  products: DujiaoProduct[],
  opts: {
    host: string
    baseUrl: string
    merchantId: string | null
    shopName: string | null
    currency: string
    fetchedAt: string
  }
): NormalizedShopProductRow[] {
  const rows: NormalizedShopProductRow[] = []
  for (const p of products) {
    rows.push(...normalizeDujiaoProduct(p, opts))
  }
  return rows
}
