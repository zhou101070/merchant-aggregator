/** Coalesce dual-write shop / legacy ldxp fields during migration. */
export function resolveShopRef(input: {
  platformId?: string | null
  shopPlatform?: string | null
  shopToken?: string | null
  ldxpToken?: string | null
  /** When true, missing platform returns null instead of defaulting to ldxp */
  strictPlatform?: boolean
}): { platformId: string; token: string } | null {
  const token = (input.shopToken || input.ldxpToken || '').trim()
  if (!token) return null
  const platformId = (input.platformId || input.shopPlatform || '').trim()
  if (platformId) return { platformId, token }
  if (input.strictPlatform) return null
  return { platformId: 'ldxp', token }
}
