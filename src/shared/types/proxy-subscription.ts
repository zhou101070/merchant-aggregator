/** One airport / subscription URL, maps to one mihomo provider + LB group. */
export interface ProxySubscription {
  id: string
  url: string
  name: string
  enabled: boolean
}

export const PROXY_SUBSCRIPTIONS_MAX = 10

export function newProxySubscriptionId(): string {
  return `s${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
}

/**
 * Subscription fetch URL for mihomo proxy-providers.
 * Only http(s) — rejects file/data/javascript and non-URL strings (SSRF surface).
 * Local converters (http://127.0.0.1:…) are allowed.
 */
export function isAllowedProxySubscriptionUrl(url: string): boolean {
  const raw = url.trim()
  if (!raw || raw.length > 2048) return false
  let parsed: URL
  try {
    parsed = new URL(raw)
  } catch {
    return false
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return false
  if (!parsed.hostname) return false
  return true
}

/** Normalize + cap; drop empty / non-http(s) URLs; keep stable ids. */
export function normalizeProxySubscriptions(raw: unknown): ProxySubscription[] {
  if (!Array.isArray(raw)) return []
  const out: ProxySubscription[] = []
  const seenId = new Set<string>()
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const o = item as Record<string, unknown>
    const url = typeof o.url === 'string' ? o.url.trim() : ''
    if (!url || !isAllowedProxySubscriptionUrl(url)) continue
    let id =
      typeof o.id === 'string'
        ? o.id.trim().replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 32)
        : ''
    if (!id || seenId.has(id)) {
      id = newProxySubscriptionId().replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 32)
    }
    seenId.add(id)
    const nameRaw = typeof o.name === 'string' ? o.name.trim() : ''
    const name = nameRaw || `订阅 ${out.length + 1}`
    const enabled = typeof o.enabled === 'boolean' ? o.enabled : true
    out.push({ id, url, name, enabled })
    if (out.length >= PROXY_SUBSCRIPTIONS_MAX) break
  }
  return out
}

/** Prefer first enabled URL, else first, else ''. */
export function primaryProxySubscriptionUrl(subs: ProxySubscription[]): string {
  const en = subs.find((s) => s.enabled && s.url.trim())
  if (en) return en.url.trim()
  return subs[0]?.url?.trim() ?? ''
}

export function activeProxySubscriptions(subs: ProxySubscription[]): ProxySubscription[] {
  return subs.filter((s) => s.enabled && s.url.trim())
}
