/**
 * Merchant identity for cross-source dedupe (PriceAI / NodeBits / re-sync).
 * Priority: scrapable shop ref → normalized shop/entry URL.
 */

const NODEBITS_ID_PREFIX = 'nodebits-'

/** Stable link key for equality (host lowercased, path trailing slash stripped). */
export function normalizeMerchantLinkKey(url: string | null | undefined): string | null {
  if (!url?.trim()) return null
  const raw = url.trim()
  try {
    const u = new URL(raw.includes('://') ? raw : `https://${raw}`)
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null
    const host = u.hostname.toLowerCase()
    if (!host) return null
    let path = u.pathname || ''
    if (path.length > 1) path = path.replace(/\/+$/, '')
    else path = ''
    // Ignore fragment; keep query (rare but part of some shop entry links).
    return `${u.protocol}//${host}${path}${u.search}`
  } catch {
    return null
  }
}

export function shopRefIdentityKey(
  platform: string | null | undefined,
  token: string | null | undefined
): string | null {
  const p = platform?.trim().toLowerCase()
  const t = token?.trim().toLowerCase()
  if (!p || !t) return null
  return `ref:${p}:${t}`
}

/** Identity keys for a merchant-like row (order does not matter; any hit = same shop). */
export function merchantIdentityKeys(row: {
  shop_platform?: string | null
  shop_token?: string | null
  shop_url?: string | null
  entry_url?: string | null
  /** camelCase variants used by some query rows */
  shopPlatform?: string | null
  shopToken?: string | null
  shopUrl?: string | null
  entryUrl?: string | null
}): string[] {
  const platform = row.shop_platform ?? row.shopPlatform ?? null
  const token = row.shop_token ?? row.shopToken ?? null
  const shopUrl = row.shop_url ?? row.shopUrl ?? null
  const entryUrl = row.entry_url ?? row.entryUrl ?? null
  const keys = new Set<string>()
  const ref = shopRefIdentityKey(platform, token)
  if (ref) keys.add(ref)
  const shopKey = normalizeMerchantLinkKey(shopUrl)
  if (shopKey) keys.add(`url:${shopKey}`)
  const entryKey = normalizeMerchantLinkKey(entryUrl)
  if (entryKey) keys.add(`url:${entryKey}`)
  return [...keys]
}

/** Prefer stable / primary-source id when collapsing two merchants. */
export function preferMerchantId(a: string, b: string): string {
  const aNb = a.startsWith(NODEBITS_ID_PREFIX)
  const bNb = b.startsWith(NODEBITS_ID_PREFIX)
  if (aNb && !bNb) return b
  if (bNb && !aNb) return a
  // Prefer lexicographically smaller for stability (deterministic).
  return a <= b ? a : b
}

function parseJsonArray(text: string | null | undefined): string[] {
  if (!text) return []
  try {
    const v = JSON.parse(text) as unknown
    return Array.isArray(v) ? v.map(String) : []
  } catch {
    return []
  }
}

function unionJsonArrays(a: string, b: string): string {
  const set = new Set([...parseJsonArray(a), ...parseJsonArray(b)])
  return JSON.stringify([...set])
}

function preferNonEmpty(a: string | null | undefined, b: string | null | undefined): string | null {
  const at = a?.trim() || null
  const bt = b?.trim() || null
  return at ?? bt
}

function maxNum(a: number, b: number): number {
  return Math.max(a || 0, b || 0)
}

/**
 * Merge two normalized merchant rows that represent the same shop.
 * `winnerId` is the id that will be kept.
 */
export function mergeNormalizedMerchantRows<
  T extends {
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
    ldxp_token: string | null
    shop_platform: string | null
    shop_token: string | null
    name_norm: string
    _shopRefDerived: boolean
  }
>(a: T, b: T, winnerId: string): T {
  const primary = a.id === winnerId ? a : b
  const secondary = a.id === winnerId ? b : a

  // Prefer full shop home URL over product-only entry when choosing shop_url.
  let shopUrl = preferNonEmpty(primary.shop_url, secondary.shop_url)
  let entryUrl = preferNonEmpty(primary.entry_url, secondary.entry_url)
  if (!shopUrl && entryUrl) {
    // leave entry only
  } else if (shopUrl && !entryUrl) {
    entryUrl = shopUrl
  }

  const shopPlatform =
    preferNonEmpty(primary.shop_platform, secondary.shop_platform) ??
    preferNonEmpty(secondary.shop_platform, primary.shop_platform)
  const shopToken =
    preferNonEmpty(primary.shop_token, secondary.shop_token) ??
    preferNonEmpty(secondary.shop_token, primary.shop_token)
  const ldxp =
    shopPlatform === 'ldxp'
      ? shopToken
      : preferNonEmpty(primary.ldxp_token, secondary.ldxp_token)

  const platformsJson = unionJsonArrays(primary.platforms_json, secondary.platforms_json)
  const typesJson = unionJsonArrays(primary.product_types_json, secondary.product_types_json)
  const platforms = parseJsonArray(platformsJson)

  const offerCount = maxNum(primary.offer_count, secondary.offer_count)
  const inStock = maxNum(primary.in_stock_count, secondary.in_stock_count)
  const outStock = maxNum(primary.out_of_stock_count, secondary.out_of_stock_count)
  const productCount = maxNum(primary.product_count, secondary.product_count)

  let repPrice = primary.representative_price
  let repProduct = primary.representative_product
  let repTitle = primary.representative_offer_title
  let repCur = primary.representative_currency
  if (
    typeof secondary.representative_price === 'number' &&
    (repPrice == null || secondary.representative_price < repPrice)
  ) {
    repPrice = secondary.representative_price
    repProduct = secondary.representative_product
    repTitle = secondary.representative_offer_title
    repCur = secondary.representative_currency
  }

  const sourceNames = [primary.source_name, secondary.source_name]
    .map((s) => s?.trim())
    .filter((s): s is string => !!s)
  const uniqueSources = [...new Set(sourceNames)]
  const sourceName =
    uniqueSources.length > 1 ? uniqueSources.join(' · ') : (uniqueSources[0] ?? null)

  const fetchedAt =
    primary.fetched_at >= secondary.fetched_at ? primary.fetched_at : secondary.fetched_at

  return {
    ...primary,
    id: winnerId,
    name: preferNonEmpty(primary.name, secondary.name) || primary.name,
    store_name: preferNonEmpty(primary.store_name, secondary.store_name),
    host: preferNonEmpty(primary.host, secondary.host),
    shop_url: shopUrl,
    entry_url: entryUrl,
    source_id: preferNonEmpty(primary.source_id, secondary.source_id),
    source_name: sourceName,
    collector_kind: preferNonEmpty(primary.collector_kind, secondary.collector_kind),
    health_status: preferNonEmpty(primary.health_status, secondary.health_status),
    offer_count: offerCount,
    in_stock_count: inStock,
    out_of_stock_count: outStock,
    product_count: productCount,
    platform_count: Math.max(primary.platform_count, secondary.platform_count, platforms.length),
    platforms_json: platformsJson,
    product_types_json: typesJson,
    representative_product: preferNonEmpty(repProduct, secondary.representative_product),
    representative_offer_title: preferNonEmpty(repTitle, secondary.representative_offer_title),
    representative_price: repPrice,
    representative_currency: preferNonEmpty(repCur, secondary.representative_currency),
    lowest_hit_count: maxNum(primary.lowest_hit_count, secondary.lowest_hit_count),
    warranty_lowest_hit_count: maxNum(
      primary.warranty_lowest_hit_count,
      secondary.warranty_lowest_hit_count
    ),
    risk_feedback_count: maxNum(primary.risk_feedback_count, secondary.risk_feedback_count),
    has_platform_aftersales: Math.max(
      primary.has_platform_aftersales,
      secondary.has_platform_aftersales
    ),
    shop_created_at: preferNonEmpty(primary.shop_created_at, secondary.shop_created_at),
    included_at: preferNonEmpty(primary.included_at, secondary.included_at),
    last_success_at: preferNonEmpty(primary.last_success_at, secondary.last_success_at),
    latest_seen_at: preferNonEmpty(primary.latest_seen_at, secondary.latest_seen_at),
    consecutive_failures: Math.min(
      primary.consecutive_failures ?? 0,
      secondary.consecutive_failures ?? 0
    ),
    observation_started_at: preferNonEmpty(
      primary.observation_started_at,
      secondary.observation_started_at
    ),
    generated_at: preferNonEmpty(primary.generated_at, secondary.generated_at),
    fetched_at: fetchedAt,
    raw_json: primary.raw_json,
    ldxp_token: ldxp,
    shop_platform: shopPlatform,
    shop_token: shopToken,
    name_norm: primary.name_norm || secondary.name_norm,
    _shopRefDerived: primary._shopRefDerived || secondary._shopRefDerived || !!(shopPlatform && shopToken)
  }
}

/** Collapse a batch of rows that share identity keys into one row each. */
export function collapseMerchantBatch<
  T extends {
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
    ldxp_token: string | null
    shop_platform: string | null
    shop_token: string | null
    name_norm: string
    _shopRefDerived: boolean
  }
>(rows: T[]): T[] {
  if (rows.length <= 1) return rows

  // Union-find by identity keys
  const parent = new Map<string, string>()
  const find = (id: string): string => {
    let p = parent.get(id) ?? id
    while ((parent.get(p) ?? p) !== p) {
      const gp = parent.get(p) ?? p
      parent.set(p, parent.get(gp) ?? gp)
      p = parent.get(p) ?? p
    }
    parent.set(id, p)
    return p
  }
  const union = (a: string, b: string): void => {
    const ra = find(a)
    const rb = find(b)
    if (ra === rb) return
    const keep = preferMerchantId(ra, rb)
    const drop = keep === ra ? rb : ra
    parent.set(drop, keep)
  }

  for (const r of rows) parent.set(r.id, r.id)

  const keyToId = new Map<string, string>()
  for (const r of rows) {
    for (const key of merchantIdentityKeys(r)) {
      const existing = keyToId.get(key)
      if (existing) union(existing, r.id)
      else keyToId.set(key, r.id)
    }
  }

  // Also union rows that share keys transitively via re-walk
  for (const r of rows) {
    for (const key of merchantIdentityKeys(r)) {
      const existing = keyToId.get(key)
      if (existing) union(existing, r.id)
      keyToId.set(key, find(r.id))
    }
  }

  const groups = new Map<string, T[]>()
  for (const r of rows) {
    const root = find(r.id)
    const list = groups.get(root)
    if (list) list.push(r)
    else groups.set(root, [r])
  }

  const out: T[] = []
  for (const group of groups.values()) {
    if (group.length === 1) {
      out.push(group[0]!)
      continue
    }
    let winnerId = group[0]!.id
    for (let i = 1; i < group.length; i += 1) {
      winnerId = preferMerchantId(winnerId, group[i]!.id)
    }
    let merged = group[0]!
    for (let i = 1; i < group.length; i += 1) {
      merged = mergeNormalizedMerchantRows(merged, group[i]!, winnerId)
    }
    out.push(merged)
  }
  return out
}
