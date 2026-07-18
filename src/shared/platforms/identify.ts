import { parseShopUrl } from '../lib/url-parse'
import { hasDujiaoUrlHint, hasYiciyuanUrlHint } from './url-hints'
import { SHOP_PROFILES } from './shop-profiles'
import type { ShopFamily, ShopSiteProfile } from './shop-types'
import { findProfileById, normalizeHost } from './shop-types'

/** Platform id + shop_products.source for Dujiao-Next deep scrape. */
export const DUJIAO_PLATFORM_ID = 'dujiao'

/** Platform id + shop_products.source for 异次元/acg-faka 系 (PriceAI collector often `kami`). */
export const YICIYUAN_PLATFORM_ID = 'yiciyuan'

/**
 * Site technology family for routing + UI.
 * Deep-scrape adapters today: shopapi + dujiao + yiciyuan.
 */
export type ShopFamilyId =
  ShopFamily | 'dujiao' | 'yiciyuan' | 'generic_html' | 'custom_api' | 'unknown'

/** Which scrape adapter path to take. */
export type ScrapeStrategy = 'shopapi' | 'dujiao' | 'yiciyuan' | 'unsupported' | 'none'

export type IdentifyConfidence = 'high' | 'medium' | 'low'

export type IdentifySource = 'url' | 'stored_ref' | 'collector_kind' | 'legacy_ldxp' | 'none'

export interface ShopIdentity {
  family: ShopFamilyId
  /** Registered profile id when known (ldxp / catfk …) or host-token platform id */
  platformId: string | null
  token: string | null
  scrapeStrategy: ScrapeStrategy
  /** Deep-scrape possible with current adapters + credentials */
  scrapable: boolean
  profileEnabled: boolean
  confidence: IdentifyConfidence
  source: IdentifySource
  /** Short Chinese label for UI */
  label: string
  /** Why scrapable / not scrapable */
  reason: string
}

export interface IdentifyShopInput {
  host?: string | null
  shopUrl?: string | null
  entryUrl?: string | null
  shopPlatform?: string | null
  shopToken?: string | null
  ldxpToken?: string | null
  collectorKind?: string | null
}

interface CollectorMapEntry {
  family: ShopFamilyId
  label: string
  scrapeStrategy: ScrapeStrategy
  confidence: IdentifyConfidence
  /** When set, collector maps to a host-as-token scrapable family. */
  hostTokenPlatformId?: string
}

/** Host-as-token scrapable families (token = normalized hostname). */
interface HostTokenFamily {
  platformId: string
  family: ShopFamilyId
  scrapeStrategy: ScrapeStrategy
  label: string
  /** PriceAI collector_kind values that map here. */
  collectorKinds: readonly string[]
}

export const HOST_TOKEN_FAMILIES: readonly HostTokenFamily[] = [
  {
    platformId: DUJIAO_PLATFORM_ID,
    family: 'dujiao',
    scrapeStrategy: 'dujiao',
    label: '独角数卡',
    collectorKinds: ['dujiao']
  },
  {
    platformId: YICIYUAN_PLATFORM_ID,
    family: 'yiciyuan',
    scrapeStrategy: 'yiciyuan',
    label: '异次元发卡',
    // PriceAI historically buckets this API family as kami
    collectorKinds: ['kami', 'yiciyuan']
  }
]

const HOST_TOKEN_BY_PLATFORM = new Map(HOST_TOKEN_FAMILIES.map((f) => [f.platformId, f] as const))

const HOST_TOKEN_BY_COLLECTOR = new Map<string, HostTokenFamily>()
for (const f of HOST_TOKEN_FAMILIES) {
  for (const k of f.collectorKinds) {
    HOST_TOKEN_BY_COLLECTOR.set(k, f)
  }
}

/**
 * PriceAI collector_kind → family. Soft signal only: never invents tokens.
 * Unknown kinds fall through to generic mapping.
 */
const COLLECTOR_KIND_MAP: Record<string, CollectorMapEntry> = {
  shopApi: {
    family: 'shopapi',
    label: 'shopApi 白标',
    scrapeStrategy: 'none',
    confidence: 'medium'
  },
  dujiao: {
    family: 'dujiao',
    label: '独角数卡',
    scrapeStrategy: 'dujiao',
    confidence: 'high',
    hostTokenPlatformId: DUJIAO_PLATFORM_ID
  },
  // PriceAI kami is a soft bucket (mixed templates); need URL hint or stored/probed ref to scrape
  kami: {
    family: 'yiciyuan',
    label: '异次元发卡',
    scrapeStrategy: 'yiciyuan',
    confidence: 'medium',
    hostTokenPlatformId: YICIYUAN_PLATFORM_ID
  },
  yiciyuan: {
    family: 'yiciyuan',
    label: '异次元发卡',
    scrapeStrategy: 'yiciyuan',
    confidence: 'high',
    hostTokenPlatformId: YICIYUAN_PLATFORM_ID
  },
  genericHtml: {
    family: 'generic_html',
    label: '通用 HTML',
    scrapeStrategy: 'unsupported',
    confidence: 'low'
  },
  unicornHtml: {
    family: 'generic_html',
    label: 'Unicorn HTML',
    scrapeStrategy: 'unsupported',
    confidence: 'medium'
  },
  opensoraHtml: {
    family: 'generic_html',
    label: 'OpenSora HTML',
    scrapeStrategy: 'unsupported',
    confidence: 'medium'
  },
  makerichHtml: {
    family: 'generic_html',
    label: 'MakeRich',
    scrapeStrategy: 'unsupported',
    confidence: 'medium'
  },
  beibeiHtml: {
    family: 'generic_html',
    label: 'beibei HTML',
    scrapeStrategy: 'unsupported',
    confidence: 'medium'
  },
  publicProductsApi: {
    family: 'custom_api',
    label: '公开商品 API',
    scrapeStrategy: 'unsupported',
    confidence: 'medium'
  },
  shopUserProductsApi: {
    family: 'custom_api',
    label: '店铺商品 API',
    scrapeStrategy: 'unsupported',
    confidence: 'medium'
  },
  getgptApi: {
    family: 'custom_api',
    label: 'GetGPT API',
    scrapeStrategy: 'unsupported',
    confidence: 'high'
  },
  ikunloveApi: {
    family: 'custom_api',
    label: 'ikunlove API',
    scrapeStrategy: 'unsupported',
    confidence: 'high'
  },
  blackcatWholesale: {
    family: 'custom_api',
    label: 'BlackCat 批发',
    scrapeStrategy: 'unsupported',
    confidence: 'high'
  },
  xiaoheiwan: {
    family: 'custom_api',
    label: 'xiaoheiwan',
    scrapeStrategy: 'unsupported',
    confidence: 'high'
  }
}

const FAMILY_LABEL: Record<ShopFamilyId, string> = {
  shopapi: 'shopApi 白标',
  dujiao: '独角数卡',
  yiciyuan: '异次元发卡',
  generic_html: 'HTML 站',
  custom_api: '定制 API',
  unknown: '未知'
}

export function shopFamilyLabel(family: ShopFamilyId): string {
  return FAMILY_LABEL[family] ?? family
}

export function collectorKindMeta(kind: string | null | undefined): CollectorMapEntry | null {
  if (!kind?.trim()) return null
  return COLLECTOR_KIND_MAP[kind.trim()] ?? null
}

export function hostTokenFamilyByPlatformId(
  platformId: string | null | undefined
): HostTokenFamily | null {
  if (!platformId?.trim()) return null
  return HOST_TOKEN_BY_PLATFORM.get(platformId.trim()) ?? null
}

export function isHostTokenScrapeStrategy(
  strategy: ScrapeStrategy
): strategy is 'dujiao' | 'yiciyuan' {
  return strategy === 'dujiao' || strategy === 'yiciyuan'
}

function unknownIdentity(partial?: Partial<ShopIdentity>): ShopIdentity {
  return {
    family: 'unknown',
    platformId: null,
    token: null,
    scrapeStrategy: 'none',
    scrapable: false,
    profileEnabled: false,
    confidence: 'low',
    source: 'none',
    label: FAMILY_LABEL.unknown,
    reason: '无法识别发卡站点类型',
    ...partial
  }
}

function fromProfile(
  profile: ShopSiteProfile,
  token: string,
  source: IdentifySource
): ShopIdentity {
  const scrapable = profile.enabled && profile.family === 'shopapi' && !!token
  return {
    family: profile.family,
    platformId: profile.id,
    token,
    scrapeStrategy: profile.family === 'shopapi' ? 'shopapi' : 'unsupported',
    scrapable,
    profileEnabled: profile.enabled,
    confidence: 'high',
    source,
    label: profile.displayName || profile.id,
    reason: scrapable
      ? `可深刮（${profile.displayName || profile.id}）`
      : profile.enabled
        ? `已识别 ${profile.displayName || profile.id}，但当前无可用深刮适配器`
        : `平台 ${profile.displayName || profile.id} 深刮已暂停`
  }
}

function resolveHost(input: IdentifyShopInput): string | null {
  if (input.host?.trim()) return normalizeHost(input.host)
  for (const raw of [input.shopUrl, input.entryUrl]) {
    if (!raw?.trim()) continue
    try {
      const u = new URL(raw.includes('://') ? raw.trim() : `https://${raw.trim()}`)
      if (u.protocol !== 'http:' && u.protocol !== 'https:') continue
      if (u.username || u.password) continue
      return normalizeHost(u.hostname)
    } catch {
      /* continue */
    }
  }
  return null
}

function fromHostTokenFamily(
  family: HostTokenFamily,
  token: string,
  source: IdentifySource,
  opts?: {
    scrapable?: boolean
    confidence?: IdentifyConfidence
    reason?: string
  }
): ShopIdentity {
  const scrapable = opts?.scrapable ?? true
  const confidence = opts?.confidence ?? 'high'
  return {
    family: family.family,
    platformId: family.platformId,
    token: normalizeHost(token),
    scrapeStrategy: family.scrapeStrategy,
    scrapable,
    profileEnabled: true,
    confidence,
    source,
    label: family.label,
    reason:
      opts?.reason ??
      (scrapable ? `可深刮（${family.label}）` : `识别为${family.label}候选，尚不可深刮`)
  }
}

function fromCollectorKind(
  kind: string,
  host: string | null,
  input: IdentifyShopInput
): ShopIdentity {
  const meta = COLLECTOR_KIND_MAP[kind]
  if (meta) {
    if (meta.hostTokenPlatformId && isHostTokenScrapeStrategy(meta.scrapeStrategy)) {
      const family = HOST_TOKEN_BY_PLATFORM.get(meta.hostTokenPlatformId)
      if (family) {
        if (!host) {
          return {
            family: family.family,
            platformId: null,
            token: null,
            scrapeStrategy: family.scrapeStrategy,
            scrapable: false,
            profileEnabled: true,
            confidence: meta.confidence,
            source: 'collector_kind',
            label: family.label,
            reason: `识别为${family.label}，但缺少站点 host`
          }
        }
        // Soft buckets (kami): only scrapable when URL path fingerprints the family
        if (family.platformId === YICIYUAN_PLATFORM_ID && kind === 'kami') {
          if (hasYiciyuanUrlHint(input.shopUrl, input.entryUrl)) {
            return fromHostTokenFamily(family, host, 'collector_kind', {
              scrapable: true,
              confidence: 'high',
              reason: '可深刮（异次元路径指纹 + 上游 kami）'
            })
          }
          return fromHostTokenFamily(family, host, 'collector_kind', {
            scrapable: false,
            confidence: 'medium',
            reason: '上游标注 kami（异次元候选），需 API 指纹确认后才能深刮'
          })
        }
        if (
          family.platformId === DUJIAO_PLATFORM_ID &&
          hasDujiaoUrlHint(input.shopUrl, input.entryUrl)
        ) {
          return fromHostTokenFamily(family, host, 'collector_kind', {
            scrapable: true,
            confidence: 'high',
            reason: '可深刮（独角路径指纹 + 上游 dujiao）'
          })
        }
        // dujiao / explicit yiciyuan collector: keep scrapable with host
        return fromHostTokenFamily(family, host, 'collector_kind', {
          scrapable: true,
          confidence: meta.confidence,
          reason: `可深刮（${family.label}）`
        })
      }
    }
    const needsAdapter = meta.scrapeStrategy === 'unsupported'
    return {
      family: meta.family,
      platformId: null,
      token: null,
      scrapeStrategy: meta.scrapeStrategy,
      scrapable: false,
      profileEnabled: false,
      confidence: meta.confidence,
      source: 'collector_kind',
      label: meta.label,
      reason: needsAdapter
        ? `识别为${meta.label}，本应用尚未接入深刮`
        : meta.family === 'shopapi'
          ? '上游标注为 shopApi，但缺少可解析的店铺 URL/token'
          : `识别为${meta.label}，不可深刮`
    }
  }
  return unknownIdentity({
    source: 'collector_kind',
    label: kind,
    reason: `上游采集类型 ${kind}，无深刮适配器`,
    confidence: 'low'
  })
}

/**
 * Identify card-shop platform type for sync routing and UI.
 *
 * Priority:
 * 1) shop_url / entry_url host-gated parse → registered profile + token
 * 2) stored shop_platform + shop_token (or legacy ldxp_token) when profile known / host-token family
 * 3) collector_kind: host-token families + host; soft buckets need URL/API confirmation
 * 4) URL path hints alone (no collector) → candidate, not scrapable unless stored ref
 * 5) unknown
 */
export function identifyShopPlatform(
  input: IdentifyShopInput,
  profiles: readonly ShopSiteProfile[] = SHOP_PROFILES
): ShopIdentity {
  const fromShop = parseShopUrl(input.shopUrl, profiles)
  if (fromShop) return fromProfile(fromShop.profile, fromShop.token, 'url')

  const fromEntry = parseShopUrl(input.entryUrl, profiles)
  if (fromEntry) return fromProfile(fromEntry.profile, fromEntry.token, 'url')

  const storedToken = (input.shopToken || input.ldxpToken || '').trim()
  const storedPlatform = (input.shopPlatform || '').trim()
  if (storedPlatform && storedToken) {
    // Legacy alias: PriceAI/old UI may store kami — treat as yiciyuan only after probe wrote ref
    const platformKey = storedPlatform === 'kami' ? YICIYUAN_PLATFORM_ID : storedPlatform
    const hostFamily = HOST_TOKEN_BY_PLATFORM.get(platformKey)
    if (hostFamily) {
      // Stored kami without probe is weak; require yiciyuan id or URL hint
      if (storedPlatform === 'kami' && !hasYiciyuanUrlHint(input.shopUrl, input.entryUrl)) {
        return fromHostTokenFamily(hostFamily, storedToken, 'stored_ref', {
          scrapable: false,
          confidence: 'medium',
          reason: '历史标记 kami，需 API 指纹确认'
        })
      }
      return fromHostTokenFamily(hostFamily, storedToken, 'stored_ref')
    }
    const profile = findProfileById(storedPlatform, profiles)
    if (profile) return fromProfile(profile, storedToken, 'stored_ref')
    return unknownIdentity({
      platformId: storedPlatform,
      token: storedToken,
      source: 'stored_ref',
      label: storedPlatform,
      reason: `已有平台标记 ${storedPlatform}，但不在已注册 profile 中`,
      confidence: 'medium'
    })
  }

  // Legacy: ldxp_token without shop_platform
  if (!storedPlatform && storedToken && input.ldxpToken?.trim()) {
    const profile = findProfileById('ldxp', profiles)
    if (profile) return fromProfile(profile, storedToken, 'legacy_ldxp')
  }

  const host = resolveHost(input)
  const kind = input.collectorKind?.trim()
  if (kind) return fromCollectorKind(kind, host, input)

  // URL path hint without collector / stored ref: label only (probe or sync writes scrapable ref)
  if (host) {
    if (hasYiciyuanUrlHint(input.shopUrl, input.entryUrl)) {
      const family = HOST_TOKEN_BY_PLATFORM.get(YICIYUAN_PLATFORM_ID)!
      return fromHostTokenFamily(family, host, 'url', {
        scrapable: true,
        confidence: 'medium',
        reason: '可深刮（异次元路径指纹）'
      })
    }
    if (hasDujiaoUrlHint(input.shopUrl, input.entryUrl)) {
      const family = HOST_TOKEN_BY_PLATFORM.get(DUJIAO_PLATFORM_ID)!
      return fromHostTokenFamily(family, host, 'url', {
        scrapable: true,
        confidence: 'medium',
        reason: '可深刮（独角路径指纹）'
      })
    }
  }

  return unknownIdentity()
}

/**
 * True when identity can deep-scrape with current adapters right now
 * (shopapi profile or host-token families).
 */
export function isIdentityScrapable(identity: ShopIdentity): boolean {
  return (
    identity.scrapable &&
    identity.profileEnabled &&
    (identity.scrapeStrategy === 'shopapi' || isHostTokenScrapeStrategy(identity.scrapeStrategy)) &&
    !!identity.platformId &&
    !!identity.token
  )
}

/**
 * Map identity to scrape target fields.
 * Includes disabled profiles (caller/scraper surfaces PAUSED) so routing stays correct.
 * Returns null for unknown / unsupported families without credentials.
 */
export function identityToScrapeRef(
  identity: ShopIdentity
): { platformId: string; token: string } | null {
  if (identity.scrapeStrategy === 'shopapi') {
    // Include disabled profiles so sync can surface PAUSED
    if (!identity.platformId || !identity.token) return null
    return { platformId: identity.platformId, token: identity.token }
  }
  if (isHostTokenScrapeStrategy(identity.scrapeStrategy)) {
    // Soft candidates (e.g. kami without fingerprint) keep family label but no scrape ref
    if (!identity.scrapable || !identity.platformId || !identity.token) return null
    return { platformId: identity.platformId, token: identity.token }
  }
  return null
}

/** Collector kinds that backfill/list as a given host-token platform. */
export function collectorKindsForHostTokenPlatform(platformId: string): string[] {
  return HOST_TOKEN_BY_PLATFORM.get(platformId)?.collectorKinds.slice() ?? []
}

export function hostTokenPlatformIds(): string[] {
  return HOST_TOKEN_FAMILIES.map((f) => f.platformId)
}
