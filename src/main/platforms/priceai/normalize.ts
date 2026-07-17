import { nameNorm } from '@shared/lib/name-norm'
import { parseShopUrl } from '@shared/lib/url-parse'
import type { PriceaiMerchantRawParsed } from './zod'

export interface NormalizedMerchantRow {
  id: string
  name: string
  store_name: string | null
  host: string | null
  shop_url: string | null
  entry_url: string | null
  source_id: string | null
  source_name: string | null
  collector_kind: string | null
  health_status: string | null
  offer_count: number
  in_stock_count: number
  out_of_stock_count: number
  product_count: number
  platform_count: number
  platforms_json: string
  product_types_json: string
  representative_product: string | null
  representative_offer_title: string | null
  representative_price: number | null
  representative_currency: string | null
  lowest_hit_count: number
  warranty_lowest_hit_count: number
  risk_feedback_count: number
  has_platform_aftersales: number
  shop_created_at: string | null
  included_at: string | null
  last_success_at: string | null
  latest_seen_at: string | null
  consecutive_failures: number
  observation_started_at: string | null
  generated_at: string | null
  fetched_at: string
  raw_json: string
  /** Only when platform is ldxp; never write catfk token here */
  ldxp_token: string | null
  shop_platform: string | null
  shop_token: string | null
  name_norm: string
  /**
   * When derive returns null, upsert must PRESERVE existing shop_* columns (D19).
   * Flag tells MerchantsRepo to use COALESCE on conflict.
   */
  _shopRefDerived: boolean
}

function n(v: number | null | undefined, fallback = 0): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback
}

function s(v: string | null | undefined): string | null {
  if (v == null) return null
  const t = String(v).trim()
  return t.length ? t : null
}

/** 有可打开外链：shop_url 或 entry_url 任一非空 */
export function hasMerchantExternalLink(row: {
  shop_url?: string | null
  entry_url?: string | null
}): boolean {
  return !!(row.shop_url?.trim() || row.entry_url?.trim())
}

export interface DerivedShopRef {
  shop_platform: string
  shop_token: string
  ldxp_token: string | null
}

/**
 * Host-gated shop ref derivation (bugfix for wrong-platform attribution).
 * Returns null when URL/host does not match a registered scrapable shop profile.
 */
export function deriveShopRef(input: {
  host?: string | null
  shopUrl?: string | null
  entryUrl?: string | null
}): DerivedShopRef | null {
  const fromShop = parseShopUrl(input.shopUrl)
  if (fromShop) {
    return {
      shop_platform: fromShop.platformId,
      shop_token: fromShop.token,
      ldxp_token: fromShop.platformId === 'ldxp' ? fromShop.token : null
    }
  }
  const fromEntry = parseShopUrl(input.entryUrl)
  if (fromEntry) {
    return {
      shop_platform: fromEntry.platformId,
      shop_token: fromEntry.token,
      ldxp_token: fromEntry.platformId === 'ldxp' ? fromEntry.token : null
    }
  }
  return null
}

/** @deprecated use deriveShopRef; only returns token for ldxp */
export function deriveLdxpToken(input: {
  host?: string | null
  shopUrl?: string | null
  entryUrl?: string | null
}): string | null {
  return deriveShopRef(input)?.ldxp_token ?? null
}

export function normalizeMerchant(
  raw: PriceaiMerchantRawParsed,
  opts: { fetchedAt: string; generatedAt?: string | null }
): NormalizedMerchantRow {
  const platforms = raw.platforms ?? []
  const productTypes = raw.productTypes ?? []
  const name = raw.name
  const storeName = s(raw.storeName) ?? null
  const nameNormValue = nameNorm(storeName || name)

  const ref = deriveShopRef({
    host: raw.host,
    shopUrl: raw.shopUrl,
    entryUrl: raw.entryUrl
  })

  return {
    id: raw.id,
    name,
    store_name: storeName,
    host: s(raw.host),
    shop_url: s(raw.shopUrl),
    entry_url: s(raw.entryUrl),
    source_id: s(raw.sourceId),
    source_name: s(raw.sourceName),
    collector_kind: s(raw.collectorKind),
    health_status: s(raw.healthStatus),
    offer_count: n(raw.offerCount),
    in_stock_count: n(raw.inStockCount),
    out_of_stock_count: n(raw.outOfStockCount),
    product_count: n(raw.productCount),
    platform_count: n(raw.platformCount, platforms.length),
    platforms_json: JSON.stringify(platforms),
    product_types_json: JSON.stringify(productTypes),
    representative_product: s(raw.representativeProduct),
    representative_offer_title: s(raw.representativeOfferTitle),
    representative_price:
      typeof raw.representativePrice === 'number' ? raw.representativePrice : null,
    representative_currency: s(raw.representativeCurrency),
    lowest_hit_count: n(raw.lowestHitCount),
    warranty_lowest_hit_count: n(raw.warrantyLowestHitCount),
    risk_feedback_count: n(raw.riskFeedbackCount),
    has_platform_aftersales: raw.hasPlatformAftersalesMechanism ? 1 : 0,
    shop_created_at: s(raw.shopCreatedAt),
    included_at: s(raw.includedAt),
    last_success_at: s(raw.lastSuccessAt),
    latest_seen_at: s(raw.latestSeenAt),
    consecutive_failures: n(raw.consecutiveFailures),
    observation_started_at: s(raw.observationStartedAt),
    generated_at: s(opts.generatedAt),
    fetched_at: opts.fetchedAt,
    raw_json: JSON.stringify(raw),
    ldxp_token: ref?.ldxp_token ?? null,
    shop_platform: ref?.shop_platform ?? null,
    shop_token: ref?.shop_token ?? null,
    name_norm: nameNormValue,
    _shopRefDerived: ref != null
  }
}
