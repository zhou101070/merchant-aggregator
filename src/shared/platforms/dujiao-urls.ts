/**
 * Dujiao-Next public page paths (SPA).
 * Catalog:  {origin}/products
 * Detail:   {origin}/products/{slug}
 */

export const DUJIAO_PRODUCTS_PATH = '/products'

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
export function dujiaoOrigin(
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

/** Full catalog page: https://example.com/products */
export function dujiaoCatalogUrl(
  input: string | null | undefined,
  fallbackHost?: string | null
): string | null {
  const origin = dujiaoOrigin(input, fallbackHost)
  return origin ? `${origin}${DUJIAO_PRODUCTS_PATH}` : null
}

/** Product detail page: https://example.com/products/{slug} */
export function dujiaoProductPageUrl(originOrBase: string, slug: string): string | null {
  const origin = dujiaoOrigin(originOrBase)
  const s = slug.trim()
  if (!origin || !s) return null
  // goods_key may be `slug#skuId` for multi-SKU rows
  const pathSlug = s.includes('#') ? s.slice(0, s.indexOf('#')) : s
  if (!pathSlug) return null
  return `${origin}${DUJIAO_PRODUCTS_PATH}/${encodeURIComponent(pathSlug)}`
}
