/**
 * NodeBits = second **merchant-list** source only.
 *
 * - Does NOT write shop_products or run deep scrape.
 * - External shop URL comes from `/go?type=shop&id=` intermediate page.
 * - Platform identity always goes through shared `normalizeMerchant` →
 *   `identifyShopPlatform` (same path as PriceAI).
 */
import type { PriceaiMerchantRawParsed } from '../priceai/zod'
import {
  hasMerchantExternalLink,
  normalizeMerchant,
  type NormalizedMerchantRow
} from '../priceai/normalize'
import type { NodebitsShopRaw } from './zod'

/** Local merchant id prefix so NodeBits UUIDs never collide with PriceAI ids. */
export const NODEBITS_ID_PREFIX = 'nodebits-'

export interface ShopUrlEnrichment {
  shopUrl: string | null
  entryUrl: string | null
  host: string | null
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

/** Build link fields from a resolved external URL (NodeBits /go target). */
export function enrichFromExternalUrl(url: string | null | undefined): ShopUrlEnrichment {
  const entryUrl = url?.trim() || null
  const shopUrl = entryUrl
  return {
    shopUrl,
    entryUrl,
    host: tryParseHost(shopUrl) ?? tryParseHost(entryUrl)
  }
}

export function nodebitsMerchantId(shopId: string): string {
  if (shopId.startsWith(NODEBITS_ID_PREFIX)) return shopId
  return `${NODEBITS_ID_PREFIX}${shopId}`
}

/** Build PriceAI-shaped raw row then reuse priceai normalize (shop ref derivation). */
export function toPriceaiLikeRaw(
  shop: NodebitsShopRaw,
  enrichment: ShopUrlEnrichment
): PriceaiMerchantRawParsed {
  const tags = (shop.tags ?? []).filter((t) => !!t?.trim())
  const name = shop.name.trim()

  return {
    id: nodebitsMerchantId(shop.id),
    name,
    storeName: name,
    host: enrichment.host,
    shopUrl: enrichment.shopUrl,
    entryUrl: enrichment.entryUrl,
    sourceId: shop.id,
    sourceName: 'NodeBits',
    collectorKind: null,
    healthStatus: null,
    offerCount: 0,
    inStockCount: 0,
    outOfStockCount: 0,
    productCount: 0,
    platformCount: tags.length,
    platforms: tags,
    productTypes: [],
    representativeProduct: null,
    representativeOfferTitle: null,
    representativePrice: null,
    representativeCurrency: null,
    lowestHitCount: 0,
    warrantyLowestHitCount: 0,
    riskFeedbackCount: 0,
    hasPlatformAftersalesMechanism: false,
    shopCreatedAt: shop.created_at ?? null,
    includedAt: shop.created_at ?? null,
    lastSuccessAt: null,
    latestSeenAt: null,
    consecutiveFailures: 0,
    observationStartedAt: null
  }
}

export function normalizeNodebitsMerchant(
  shop: NodebitsShopRaw,
  opts: {
    fetchedAt: string
    generatedAt?: string | null
    /** URL from /go intermediate page. */
    externalUrl?: string | null
  }
): NormalizedMerchantRow {
  const enrichment = enrichFromExternalUrl(opts.externalUrl)
  // Prefer shop home as entry when known
  if (enrichment.shopUrl) enrichment.entryUrl = enrichment.shopUrl
  const raw = toPriceaiLikeRaw(shop, enrichment)
  const row = normalizeMerchant(raw, opts)
  row.raw_json = JSON.stringify({
    shop,
    enrichment,
    externalUrl: opts.externalUrl ?? null
  })
  return row
}

export { hasMerchantExternalLink }
export type { NormalizedMerchantRow }
