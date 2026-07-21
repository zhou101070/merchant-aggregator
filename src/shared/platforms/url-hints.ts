/**
 * Lightweight URL path fingerprints for host-token families.
 * Used by identify (sync, no network). Live API probe lives in main.
 */

export type UrlFamilyHint = 'yiciyuan' | 'dujiao' | null

function tryParseUrl(raw: string | null | undefined): URL | null {
  if (!raw?.trim()) return null
  try {
    const u = new URL(raw.includes('://') ? raw.trim() : `https://${raw.trim()}`)
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null
    if (u.username || u.password) return null
    return u
  } catch {
    return null
  }
}

/** 异次元/acg-faka 常见公开路径 */
const YICIYUAN_PATH =
  /\/item\/\d+(?:\/|$|\?)|\/user\/(?:api\/|authentication\/|index\/|recharge\/|ticket\/)|\/app\/View\/User\/Theme\//i

/** 独角 Next 常见公开路径 */
const DUJIAO_PATH = /\/products(?:\/|$|\?)|\/api\/v1\/public\//i

/**
 * Infer family from shop/entry URL path only (no host allowlist).
 * First matching URL wins; prefer shopUrl then entryUrl.
 */
export function familyHintFromUrls(
  shopUrl?: string | null,
  entryUrl?: string | null
): UrlFamilyHint {
  for (const raw of [shopUrl, entryUrl]) {
    const u = tryParseUrl(raw)
    if (!u) continue
    const path = `${u.pathname}${u.search}`
    if (YICIYUAN_PATH.test(path)) return 'yiciyuan'
    if (DUJIAO_PATH.test(path)) return 'dujiao'
  }
  return null
}

export function hasYiciyuanUrlHint(shopUrl?: string | null, entryUrl?: string | null): boolean {
  return familyHintFromUrls(shopUrl, entryUrl) === 'yiciyuan'
}

export function hasDujiaoUrlHint(shopUrl?: string | null, entryUrl?: string | null): boolean {
  return familyHintFromUrls(shopUrl, entryUrl) === 'dujiao'
}
