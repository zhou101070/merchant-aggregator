import {
  identifyShopPlatform,
  identityToScrapeRef,
  type ShopIdentity
} from '@shared/platforms/identify'

/** Coalesce dual-write shop / legacy ldxp fields via identifyShopPlatform. */
export function resolveShopRef(input: {
  platformId?: string | null
  shopPlatform?: string | null
  shopToken?: string | null
  ldxpToken?: string | null
  shopUrl?: string | null
  entryUrl?: string | null
  host?: string | null
  collectorKind?: string | null
  /** When true, missing platform returns null instead of defaulting to ldxp */
  strictPlatform?: boolean
}): { platformId: string; token: string } | null {
  const identity = identifyShopPlatform({
    host: input.host,
    shopUrl: input.shopUrl,
    entryUrl: input.entryUrl,
    shopPlatform: input.platformId || input.shopPlatform,
    shopToken: input.shopToken,
    ldxpToken: input.ldxpToken,
    collectorKind: input.collectorKind
  })
  const ref = identityToScrapeRef(identity)
  if (ref) return ref
  if (input.strictPlatform) return null
  // Legacy fallback only when token present without platform (pre-identify paths)
  const token = (input.shopToken || input.ldxpToken || '').trim()
  if (!token) return null
  const platformId = (input.platformId || input.shopPlatform || '').trim()
  if (platformId) return { platformId, token }
  return { platformId: 'ldxp', token }
}

/** Full identity for UI (type badge / why not scrapable). */
export function resolveShopIdentity(input: {
  shopPlatform?: string | null
  shopToken?: string | null
  ldxpToken?: string | null
  shopUrl?: string | null
  entryUrl?: string | null
  host?: string | null
  collectorKind?: string | null
}): ShopIdentity {
  return identifyShopPlatform(input)
}
