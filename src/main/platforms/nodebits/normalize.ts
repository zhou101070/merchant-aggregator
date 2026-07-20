/**
 * NodeBits = second **merchant-list** source only.
 *
 * - Does NOT write shop_products or run deep scrape.
 * - Product API pages are used only to recover shop/entry URLs + offer stats for the merchant row.
 * - Platform identity / scrapability always go through shared `normalizeMerchant` →
 *   `identifyShopPlatform` (same path as PriceAI). Shop product sync later uses registry +
 *   shop_platform/shop_token like any other merchant.
 */
import type { PriceaiMerchantRawParsed } from '../priceai/zod'
import {
  hasMerchantExternalLink,
  normalizeMerchant,
  type NormalizedMerchantRow
} from '../priceai/normalize'
import type { NodebitsProductRaw, NodebitsShopRaw } from './zod'

/** Local merchant id prefix so NodeBits UUIDs never collide with PriceAI ids. */
export const NODEBITS_ID_PREFIX = 'nodebits-'

/** Map NodeBits product raw_text.source → PriceAI-shaped collector_kind for shared deriveShopRef. */
const SOURCE_TO_COLLECTOR: Record<string, string> = {
  ldxp: 'shopApi',
  shopapi: 'shopApi',
  shopApi: 'shopApi',
  catfk: 'shopApi',
  dujiao: 'dujiao',
  kami: 'kami',
  yiciyuan: 'yiciyuan'
}

export interface ShopProductEnrichment {
  shopUrl: string | null
  entryUrl: string | null
  host: string | null
  collectorKind: string | null
  sourceLabel: string | null
  productCount: number
  inStockCount: number
  outOfStockCount: number
  platforms: string[]
  productTypes: string[]
  representativeProduct: string | null
  representativeOfferTitle: string | null
  representativePrice: number | null
  representativeCurrency: string | null
  latestSeenAt: string | null
}

function tryParseHost(url: string | null | undefined): string | null {
  if (!url?.trim()) return null
  try {
    const u = new URL(url.includes('://') ? url.trim() : `https://${url.trim()}`)
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null
    return u.hostname.toLowerCase() || null
  } catch {
    return null
  }
}

function parseRawText(rawText: string | null | undefined): Record<string, unknown> | null {
  if (!rawText?.trim()) return null
  try {
    const v = JSON.parse(rawText) as unknown
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null
  } catch {
    return null
  }
}

function strField(raw: Record<string, unknown>, ...keys: string[]): string | null {
  for (const k of keys) {
    const v = raw[k]
    if (typeof v === 'string' && v.trim()) return v.trim()
  }
  return null
}

function isInStock(status: string | null | undefined, stockCount: number | null | undefined): boolean {
  if (typeof stockCount === 'number' && Number.isFinite(stockCount)) return stockCount > 0
  const s = (status ?? '').toLowerCase()
  if (!s) return false
  if (s === 'out_of_stock' || s === 'sold_out' || s === 'unavailable') return false
  if (s === 'in_stock' || s === 'low_stock' || s === 'available') return true
  return s !== 'out'
}

/**
 * Aggregate products for one shop into link + offer stats.
 * Prefer `raw_text.shopUrl` (full shop path); fall back to product_url as entry only.
 */
export function enrichFromProducts(products: NodebitsProductRaw[]): ShopProductEnrichment {
  let shopUrl: string | null = null
  let entryUrl: string | null = null
  let collectorKind: string | null = null
  let sourceLabel: string | null = null
  let inStockCount = 0
  let outOfStockCount = 0
  let latestSeenAt: string | null = null
  const platforms = new Set<string>()
  const productTypes = new Set<string>()
  let representativeProduct: string | null = null
  let representativeOfferTitle: string | null = null
  let representativePrice: number | null = null
  let representativeCurrency: string | null = null

  for (const p of products) {
    if (p.category?.trim()) platforms.add(p.category.trim())
    if (p.product_type_name?.trim()) productTypes.add(p.product_type_name.trim())
    else if (p.product_type?.trim()) productTypes.add(p.product_type.trim())

    if (isInStock(p.stock_status, p.stock_count)) inStockCount += 1
    else outOfStockCount += 1

    if (p.last_seen_at && (!latestSeenAt || p.last_seen_at > latestSeenAt)) {
      latestSeenAt = p.last_seen_at
    }

    const raw = parseRawText(p.raw_text)
    if (raw) {
      const rawShopUrl = strField(raw, 'shopUrl', 'shop_url')
      if (rawShopUrl && !shopUrl) {
        shopUrl = rawShopUrl
        const src = strField(raw, 'source')
        if (src) {
          sourceLabel = src
          collectorKind = SOURCE_TO_COLLECTOR[src] ?? collectorKind
        }
      }
      const rawSource = strField(raw, 'source')
      if (rawSource && !collectorKind) {
        sourceLabel = sourceLabel ?? rawSource
        collectorKind = SOURCE_TO_COLLECTOR[rawSource] ?? null
      }
      const typeName = strField(raw, 'typeName', 'type_name')
      if (typeName) productTypes.add(typeName)
    }

    const productUrl = p.product_url?.trim() || null
    if (productUrl && !entryUrl) entryUrl = productUrl

    if (
      representativePrice == null ||
      (typeof p.price === 'number' &&
        Number.isFinite(p.price) &&
        p.price < (representativePrice ?? Number.POSITIVE_INFINITY))
    ) {
      if (typeof p.price === 'number' && Number.isFinite(p.price)) {
        representativePrice = p.price
        representativeCurrency = p.currency?.trim() || 'CNY'
        representativeProduct = p.normalized_title?.trim() || p.title?.trim() || null
        representativeOfferTitle = p.title?.trim() || null
      }
    }
  }

  // Prefer shop home as entry when known
  if (shopUrl) entryUrl = shopUrl
  const host = tryParseHost(shopUrl) ?? tryParseHost(entryUrl)

  return {
    shopUrl,
    entryUrl,
    host,
    collectorKind,
    sourceLabel,
    productCount: products.length,
    inStockCount,
    outOfStockCount,
    platforms: [...platforms],
    productTypes: [...productTypes],
    representativeProduct,
    representativeOfferTitle,
    representativePrice,
    representativeCurrency,
    latestSeenAt
  }
}

export function nodebitsMerchantId(shopId: string): string {
  if (shopId.startsWith(NODEBITS_ID_PREFIX)) return shopId
  return `${NODEBITS_ID_PREFIX}${shopId}`
}

/** Build PriceAI-shaped raw row then reuse priceai normalize (shop ref derivation). */
export function toPriceaiLikeRaw(
  shop: NodebitsShopRaw,
  enrichment: ShopProductEnrichment
): PriceaiMerchantRawParsed {
  const tags = (shop.tags ?? []).filter((t) => !!t?.trim())
  const platforms = enrichment.platforms.length ? enrichment.platforms : tags
  const name = shop.name.trim()

  return {
    id: nodebitsMerchantId(shop.id),
    name,
    storeName: name,
    host: enrichment.host,
    shopUrl: enrichment.shopUrl,
    entryUrl: enrichment.entryUrl,
    sourceId: shop.id,
    sourceName: enrichment.sourceLabel
      ? `NodeBits / ${enrichment.sourceLabel}`
      : 'NodeBits',
    collectorKind: enrichment.collectorKind,
    healthStatus: null,
    offerCount: enrichment.productCount,
    inStockCount: enrichment.inStockCount,
    outOfStockCount: enrichment.outOfStockCount,
    productCount: enrichment.productCount,
    platformCount: platforms.length,
    platforms,
    productTypes: enrichment.productTypes,
    representativeProduct: enrichment.representativeProduct,
    representativeOfferTitle: enrichment.representativeOfferTitle,
    representativePrice: enrichment.representativePrice,
    representativeCurrency: enrichment.representativeCurrency,
    lowestHitCount: 0,
    warrantyLowestHitCount: 0,
    riskFeedbackCount: 0,
    hasPlatformAftersalesMechanism: false,
    shopCreatedAt: shop.created_at ?? null,
    includedAt: shop.created_at ?? null,
    lastSuccessAt: enrichment.latestSeenAt,
    latestSeenAt: enrichment.latestSeenAt,
    consecutiveFailures: 0,
    observationStartedAt: null
  }
}

export function normalizeNodebitsMerchant(
  shop: NodebitsShopRaw,
  products: NodebitsProductRaw[],
  opts: { fetchedAt: string; generatedAt?: string | null }
): NormalizedMerchantRow {
  const enrichment = enrichFromProducts(products)
  // Merge shop tags into platforms when products lack category
  if (!enrichment.platforms.length && shop.tags?.length) {
    enrichment.platforms = shop.tags.filter((t) => !!t?.trim())
  }
  const raw = toPriceaiLikeRaw(shop, enrichment)
  const row = normalizeMerchant(raw, opts)
  // Keep full nodebits payload for diagnostics
  row.raw_json = JSON.stringify({ shop, enrichment, productSample: products.slice(0, 3) })
  return row
}

export { hasMerchantExternalLink }
export type { NormalizedMerchantRow }
