/**
 * 异次元发卡 (acg-faka 系) public page paths.
 * Catalog:  {origin}/
 * Detail:   {origin}/item/{id}
 */

export const YICIYUAN_ITEM_PATH = '/item'

function tryOrigin(raw: string): string | null {
  const t = raw.trim()
  if (!t) return null
  try {
    const u = new URL(t.includes('://') ? t : `https://${t}`)
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null
    return u.origin
  } catch {
    return null
  }
}

/** Resolve https? origin from shop/entry URL or bare host. */
export function yiciyuanOrigin(
  input: string | null | undefined,
  fallbackHost?: string | null
): string | null {
  if (input?.trim()) {
    const o = tryOrigin(input)
    if (o) return o
  }
  if (fallbackHost?.trim()) {
    return tryOrigin(fallbackHost)
  }
  return null
}

/** Shop root (catalog): site origin + /. */
export function yiciyuanCatalogUrl(
  input: string | null | undefined,
  fallbackHost?: string | null
): string | null {
  const origin = yiciyuanOrigin(input, fallbackHost)
  return origin ? `${origin}/` : null
}

/** Product detail: https://example.com/item/{id} */
export function yiciyuanProductPageUrl(
  originOrBase: string,
  goodsKey: string
): string | null {
  const origin = yiciyuanOrigin(originOrBase)
  const id = goodsKey.trim()
  if (!origin || !id) return null
  return `${origin}${YICIYUAN_ITEM_PATH}/${encodeURIComponent(id)}`
}
