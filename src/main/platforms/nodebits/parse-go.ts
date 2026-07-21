/**
 * Parse NodeBits intermediate jump page HTML:
 *   /go?type=shop&id={uuid}
 * Target shop URL is on the "不想等待,直接前往" control (or auto-redirect target).
 */

const NODEBITS_HOST_RE = /(^|\.)nodebits\.xyz$/i
const ASSET_RE = /\.(css|js|mjs|map|png|jpe?g|gif|svg|webp|ico|woff2?|ttf)(\?|$)/i
const CF_RE = /cloudflare|challenges\.cloudflare/i

function decodeHtmlEntities(s: string): string {
  return s
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
}

function tryAbsoluteUrl(raw: string, base: string): string | null {
  const t = decodeHtmlEntities(raw).trim()
  if (!t || t.startsWith('#') || t.startsWith('javascript:')) return null
  try {
    const u = new URL(t, base)
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null
    return u.href
  } catch {
    return null
  }
}

function isUsefulExternalUrl(href: string): boolean {
  try {
    const u = new URL(href)
    if (NODEBITS_HOST_RE.test(u.hostname)) return false
    if (CF_RE.test(u.hostname) || CF_RE.test(href)) return false
    if (ASSET_RE.test(u.pathname)) return false
    return true
  } catch {
    return false
  }
}

/**
 * Extract external shop URL from /go intermediate HTML.
 * Returns null on Cloudflare challenge shell or when no target is found.
 */
export function parseNodebitsGoTargetHtml(
  html: string,
  options?: { baseUrl?: string }
): string | null {
  const base = options?.baseUrl ?? 'https://www.nodebits.xyz/'
  if (!html?.trim()) return null

  // Pure CF challenge (no jump UI)
  const looksLikeJump =
    /不想等待|直接前往|安全跳转|安全中转|正在安全跳转/i.test(html)
  if (
    !looksLikeJump &&
    /just a moment|cf-browser-verification|challenge-platform|正在进行安全验证/i.test(html)
  ) {
    return null
  }

  // 1) Anchor whose text is the skip button
  const anchorRe =
    /<a\b([^>]*?)href\s*=\s*(["'])(.*?)\2([^>]*)>([\s\S]*?)<\/a>/gi
  let m: RegExpExecArray | null
  while ((m = anchorRe.exec(html)) !== null) {
    const hrefRaw = m[3] ?? ''
    const inner = (m[5] ?? '').replace(/<[^>]+>/g, ' ')
    const attrs = `${m[1] ?? ''} ${m[4] ?? ''}`
    const label = `${inner} ${attrs}`
    if (!/不想等待|直接前往/i.test(label) && !/不想等待|直接前往/i.test(inner)) {
      // still accept if label is only "直接前往"
      if (!/直接前往|不想等待/.test(inner.replace(/\s+/g, ''))) continue
    }
    const abs = tryAbsoluteUrl(hrefRaw, base)
    if (abs && isUsefulExternalUrl(abs)) return abs
  }

  // 2) Loose: href near 不想等待 / 直接前往 (either order)
  const nearPatterns = [
    /不想等待[\s\S]{0,120}?直接前往[\s\S]{0,200}?href\s*=\s*["']([^"']+)["']/i,
    /href\s*=\s*["']([^"']+)["'][\s\S]{0,200}?不想等待[\s\S]{0,80}?直接前往/i,
    /href\s*=\s*["']([^"']+)["'][\s\S]{0,120}?直接前往/i,
    /直接前往[\s\S]{0,120}?href\s*=\s*["']([^"']+)["']/i
  ]
  for (const re of nearPatterns) {
    const hit = re.exec(html)
    if (!hit?.[1]) continue
    const abs = tryAbsoluteUrl(hit[1], base)
    if (abs && isUsefulExternalUrl(abs)) return abs
  }

  // 3) meta refresh / JS assign
  const meta = html.match(
    /http-equiv\s*=\s*["']?refresh["'][^>]*content\s*=\s*["'][^"']*url\s*=\s*([^"'>\s]+)/i
  )
  if (meta?.[1]) {
    const abs = tryAbsoluteUrl(meta[1], base)
    if (abs && isUsefulExternalUrl(abs)) return abs
  }
  const loc = html.match(
    /(?:window\.)?location(?:\.href)?\s*=\s*["']([^"']+)["']/i
  )
  if (loc?.[1]) {
    const abs = tryAbsoluteUrl(loc[1], base)
    if (abs && isUsefulExternalUrl(abs)) return abs
  }

  // 4) Any external absolute URL in page (prefer http(s) shop-like paths)
  const urls = [...html.matchAll(/https?:\/\/[^\s"'<>\\]+/gi)].map((x) =>
    decodeHtmlEntities(x[0].replace(/[),.;]+$/, ''))
  )
  const external = [...new Set(urls.filter(isUsefulExternalUrl))]
  if (external.length === 1) return external[0]!
  // Prefer paths that look like shop homes
  const ranked = external.sort((a, b) => scoreUrl(b) - scoreUrl(a))
  if (ranked[0] && scoreUrl(ranked[0]) > 0) return ranked[0]

  return null
}

function scoreUrl(href: string): number {
  try {
    const u = new URL(href)
    let s = 1
    if (/\/shop\//i.test(u.pathname)) s += 5
    if (/pay\.|shop|kami|dujiao|yiciyuan|catfk|ldxp/i.test(u.hostname)) s += 3
    if (u.pathname === '/' || u.pathname === '') s += 1
    if (/\/item\//i.test(u.pathname)) s += 2
    return s
  } catch {
    return 0
  }
}

/** Build intermediate go URL for a NodeBits shop id. */
export function nodebitsShopGoUrl(baseUrl: string, shopId: string): string {
  const base = baseUrl.replace(/\/$/, '')
  const qs = new URLSearchParams({ type: 'shop', id: shopId })
  return `${base}/go?${qs.toString()}`
}
