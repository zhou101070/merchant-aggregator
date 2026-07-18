/**
 * Local lexical ranking for shop product search (no network / no ML).
 * Inspired by field-weighted retrieval + light business boosts (BM25/Scoring Profile ideas).
 */
import { nameNorm } from './name-norm'

/** Domain synonym clusters (all forms are mutual aliases after nameNorm). */
const SYNONYM_CLUSTERS: string[][] = [
  ['claude', 'claude.ai'],
  ['gpt', 'chatgpt', 'chat gpt', 'gpt4', 'gpt-4', 'gpt4o', 'gpt-4o', 'gpt3.5', 'gpt-3.5'],
  ['openai', 'open ai'],
  ['plus'],
  ['pro', '专业版'],
  ['team', '团队'],
  ['月卡', '月付', '包月', 'monthly', '1个月', '一个月'],
  ['季卡', '季付', '包季', 'quarterly', '3个月', '三个月'],
  ['年卡', '年付', '包年', 'yearly', 'annual', '年度', '1年', '一年'],
  ['直登', '成品号', '成品'],
  ['质保', '售后', '包售后']
]

export type RankRow = {
  title: string
  shopName?: string | null
  merchantName?: string | null
  categoryName?: string | null
  goodsType?: string | null
  stock?: number | null
  merchantHealth?: string | null
  fetchedAt?: string | null
  price?: number | null
}

export type RankContext = {
  q: string
  /** Original query tokens (order preserved). */
  tokens: string[]
  /** Synonym group per token (each group is nameNorm'd). */
  tokenGroups: string[][]
  /** IDF weight per primary token (nameNorm). */
  idf: Map<string, number>
  nowMs?: number
}

/**
 * Surface forms for letter+version tokens so titles with "Grok 7" / "Grok-7" / "Grok7"
 * share recall with query "grok7" or "grok 7".
 */
export function alnumSurfaceForms(token: string): string[] {
  const n = nameNorm(token)
  if (!n) return []
  const m = n.match(/^([a-z]+)(\d+[a-z0-9.]*)$/i)
  if (!m) return [n]
  const base = m[1]
  const ver = m[2]
  return [...new Set([`${base}${ver}`, `${base} ${ver}`, `${base}-${ver}`])]
}

const ALPHA_WORD = /^[a-z]+$/i
const VERSION_TAIL = /^\d+[a-z0-9.]*$/i

/** Expand one token into its synonym group (includes itself). */
export function synonymGroup(token: string): string[] {
  const n = nameNorm(token)
  if (!n) return []
  const surfaces = alnumSurfaceForms(n)
  const out = new Set<string>(surfaces)
  for (const form of surfaces) {
    for (const cluster of SYNONYM_CLUSTERS) {
      const norms = cluster.map((c) => nameNorm(c)).filter(Boolean)
      if (norms.includes(form)) {
        for (const x of norms) out.add(x)
        // also expand surface variants of each cluster member that looks glued
        for (const x of norms) {
          for (const s of alnumSurfaceForms(x)) out.add(s)
        }
      }
    }
  }
  return [...out]
}

/**
 * Build synonym groups (query order preserved).
 * - Letter+version (gpt+4 / grok+7): if glued form is in a product synonym cluster
 *   (e.g. gpt4→chatgpt), collapse to one group; otherwise keep two groups so
 *   "grok … 7" matches non-adjacent ordered titles via AND.
 */
export function expandTokenGroups(tokens: string[]): string[][] {
  const groups: string[][] = []
  for (let i = 0; i < tokens.length; i++) {
    const a = tokens[i]
    const b = tokens[i + 1]
    if (b && ALPHA_WORD.test(a) && VERSION_TAIL.test(b)) {
      const glued = `${a}${b}`
      const surfaces = new Set(alnumSurfaceForms(glued))
      const syn = synonymGroup(glued)
      const hasProductSyn = syn.some((s) => !surfaces.has(s))
      if (hasProductSyn) {
        groups.push(syn)
        i += 1
        continue
      }
    }
    const g = synonymGroup(a)
    if (g.length) groups.push(g)
  }
  return groups
}

/** Smooth IDF: log((N+1)/(df+1)) + 1, floor 1. */
export function idfWeight(catalogSize: number, df: number): number {
  const n = Math.max(1, catalogSize)
  const d = Math.max(0, df)
  return Math.log((n + 1) / (d + 1)) + 1
}

function fieldHasGroup(fieldN: string, group: string[]): boolean {
  if (!fieldN || !group.length) return false
  return group.some((g) => g && fieldN.includes(g))
}

/**
 * IDF from already-fetched candidates (no extra SQL).
 * N = candidate set size; df = rows matching any synonym in the group.
 */
export function computeIdfFromRows(
  rows: RankRow[],
  tokens: string[],
  tokenGroups: string[][]
): Map<string, number> {
  const n = Math.max(1, rows.length)
  const idf = new Map<string, number>()
  tokens.forEach((t, i) => {
    const primary = nameNorm(t)
    const group = tokenGroups[i] ?? [primary]
    let df = 0
    for (const row of rows) {
      const titleN = nameNorm(row.title ?? '')
      const shopN = nameNorm(row.shopName || row.merchantName || '')
      const catN = nameNorm(row.categoryName || '')
      const typeN = nameNorm(row.goodsType || '')
      if (
        fieldHasGroup(titleN, group) ||
        fieldHasGroup(shopN, group) ||
        fieldHasGroup(catN, group) ||
        fieldHasGroup(typeN, group)
      ) {
        df += 1
      }
    }
    idf.set(primary, idfWeight(n, df))
  })
  return idf
}

function earliestIndex(fieldN: string, group: string[], from = 0): number {
  let best = -1
  for (const g of group) {
    if (!g) continue
    const i = fieldN.indexOf(g, from)
    if (i >= 0 && (best < 0 || i < best)) best = i
  }
  return best
}

/** All groups appear in field in query order. */
export function inQueryOrder(fieldN: string, groups: string[][]): boolean {
  if (!groups.length) return true
  let pos = 0
  for (const g of groups) {
    const i = earliestIndex(fieldN, g, pos)
    if (i < 0) return false
    pos = i + 1
  }
  return true
}

/** Score adjacent co-occurrence of consecutive query tokens (max 16). */
export function adjacentPairBonus(fieldN: string, groups: string[][]): number {
  if (groups.length < 2) return 0
  let bonus = 0
  let pos = 0
  for (let i = 0; i < groups.length - 1; i++) {
    const a = earliestIndex(fieldN, groups[i], pos)
    if (a < 0) break
    const b = earliestIndex(fieldN, groups[i + 1], a + 1)
    if (b < 0) break
    const span = b - a
    if (span <= 16) bonus += 10
    else if (span <= 32) bonus += 5
    pos = a + 1
  }
  return Math.min(16, bonus)
}

export function isInStock(stock?: number | null): boolean {
  return typeof stock === 'number' && stock > 0
}

/** Lower is better for sort tie-break. */
export function healthRank(health?: string | null): number {
  if (health === 'healthy') return 0
  if (health === 'failing') return 3
  if (health === 'retrying') return 2
  return 1
}

function freshnessBoost(fetchedAt: string | null | undefined, nowMs: number): number {
  if (!fetchedAt) return 0
  const t = Date.parse(fetchedAt)
  if (!Number.isFinite(t)) {
    // seed fixtures often use 't'
    return 0
  }
  const ageH = (nowMs - t) / 3_600_000
  if (ageH <= 24) return 4
  if (ageH <= 24 * 7) return 2
  if (ageH <= 24 * 30) return 0
  if (ageH <= 24 * 90) return -3
  return -6
}

function textScore(row: RankRow, ctx: RankContext): number {
  const titleN = nameNorm(row.title ?? '')
  const shopN = nameNorm(row.shopName || row.merchantName || '')
  const catN = nameNorm(row.categoryName || '')
  const typeN = nameNorm(row.goodsType || '')
  const qn = nameNorm(ctx.q)
  const groups = ctx.tokenGroups

  let score = 0

  // Phrase (exact normalized query string)
  if (qn && titleN.includes(qn)) score += 50
  if (qn && titleN.startsWith(qn)) score += 15
  if (qn && shopN.includes(qn)) score += 4
  if (qn && catN.includes(qn)) score += 6

  if (!groups.length) return score

  let titleHits = 0
  let catHits = 0
  let shopHits = 0
  let typeHits = 0

  for (let i = 0; i < groups.length; i++) {
    const g = groups[i]
    const primary = ctx.tokens[i] ? nameNorm(ctx.tokens[i]) : g[0]
    const idf = ctx.idf.get(primary) ?? ctx.idf.get(g[0]) ?? 1.5
    // Normalize idf into a gentle multiplier ~[1, 2.2]
    const w = Math.min(2.2, Math.max(1, idf / 1.2))

    if (fieldHasGroup(titleN, g)) {
      titleHits += 1
      score += 12 * w
    } else if (fieldHasGroup(catN, g)) {
      catHits += 1
      score += 5 * w * 0.55
    } else if (fieldHasGroup(typeN, g)) {
      typeHits += 1
      score += 4 * w * 0.5
    } else if (fieldHasGroup(shopN, g)) {
      shopHits += 1
      score += 3 * w * 0.25
    }
  }

  const n = groups.length
  if (n >= 2) {
    const coverage = titleHits / n
    score += Math.round(coverage * 28)
    if (titleHits === n) score += 22
    else if (coverage < 0.5) score -= 12
  }

  if (titleHits === n && n >= 2 && inQueryOrder(titleN, groups)) {
    score += 14
  }
  score += adjacentPairBonus(titleN, groups)

  // Soft penalty: only shop/category matched, title missed most tokens
  if (n >= 2 && titleHits === 0 && shopHits + catHits + typeHits > 0) {
    score -= 18
  } else if (n >= 2 && titleHits < n * 0.5 && shopHits > titleHits) {
    score -= 10
  }

  return score
}

function businessScore(row: RankRow, nowMs: number): number {
  let score = 0
  if (isInStock(row.stock)) score += 8
  else if (row.stock === 0) score -= 5

  if (row.merchantHealth === 'healthy') score += 5
  else if (row.merchantHealth === 'failing') score -= 12
  else if (row.merchantHealth === 'retrying') score -= 6

  score += freshnessBoost(row.fetchedAt, nowMs)
  return score
}

/**
 * Combined rank score: text dominates, business is a light re-ranker.
 * final = text + business
 */
export function scoreShopRank(row: RankRow, ctx: RankContext): number {
  const now = ctx.nowMs ?? Date.now()
  const text = textScore(row, ctx)
  const biz = businessScore(row, now)
  return Math.round((text + biz) * 100) / 100
}

/** Stable multi-key compare for relevance sort (desc by default). */
export function compareRelevance(
  a: {
    score: number
    stockCount?: number | null
    price?: number | null
    merchantHealth?: string | null
    fetchedAt?: string | null
    id: string
  },
  b: {
    score: number
    stockCount?: number | null
    price?: number | null
    merchantHealth?: string | null
    fetchedAt?: string | null
    id: string
  },
  sortDir: 'asc' | 'desc' = 'desc'
): number {
  const mul = sortDir === 'asc' ? 1 : -1
  if (a.score !== b.score) return mul * (a.score - b.score)

  const aIn = isInStock(a.stockCount) ? 0 : 1
  const bIn = isInStock(b.stockCount) ? 0 : 1
  if (aIn !== bIn) return aIn - bIn

  const ap = a.price
  const bp = b.price
  if (ap == null && bp != null) return 1
  if (ap != null && bp == null) return -1
  if (ap != null && bp != null && ap !== bp) return ap - bp

  const ah = healthRank(a.merchantHealth)
  const bh = healthRank(b.merchantHealth)
  if (ah !== bh) return ah - bh

  const af = a.fetchedAt ?? ''
  const bf = b.fetchedAt ?? ''
  if (af !== bf) return bf.localeCompare(af) // newer first

  return a.id.localeCompare(b.id)
}
