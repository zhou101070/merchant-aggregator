import { SAVED_SEARCHES_MAX } from '../constants'
import type { SavedSearch } from '../types/saved-search'
import type { SearchQuery } from '../types/search'

export type SavedSearchSnapshot = {
  q: string
  titleContains: string[]
  titleExcludes: string[]
  inStockOnly: boolean
  priceMin?: number
  priceMax?: number
  merchantName?: string
  sort: NonNullable<SearchQuery['sort']>
  sortDir: NonNullable<SearchQuery['sortDir']>
}

function newId(): string {
  return `ss_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
}

/** Normalize & cap saved search list from settings JSON. */
export function normalizeSavedSearches(raw: unknown): SavedSearch[] {
  if (!Array.isArray(raw)) return []
  const out: SavedSearch[] = []
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const o = item as Record<string, unknown>
    const id = typeof o.id === 'string' && o.id.trim() ? o.id.trim() : newId()
    const name = typeof o.name === 'string' ? o.name.trim() : ''
    const q = typeof o.q === 'string' ? o.q : ''
    const titleContains = Array.isArray(o.titleContains)
      ? o.titleContains.filter((s): s is string => typeof s === 'string')
      : []
    const titleExcludes = Array.isArray(o.titleExcludes)
      ? o.titleExcludes.filter((s): s is string => typeof s === 'string')
      : []
    // Default true when missing (matches search default “只看有货”)
    const inStockOnly = o.inStockOnly === undefined ? true : Boolean(o.inStockOnly)
    const priceMin =
      typeof o.priceMin === 'number' && Number.isFinite(o.priceMin) ? o.priceMin : undefined
    const priceMax =
      typeof o.priceMax === 'number' && Number.isFinite(o.priceMax) ? o.priceMax : undefined
    const merchantName =
      typeof o.merchantName === 'string' && o.merchantName.trim()
        ? o.merchantName.trim()
        : undefined
    const sort = isSort(o.sort) ? o.sort : 'score'
    const sortDir = o.sortDir === 'asc' || o.sortDir === 'desc' ? o.sortDir : 'desc'
    const createdAt =
      typeof o.createdAt === 'string' && o.createdAt ? o.createdAt : new Date().toISOString()
    // inStockOnly alone is not a save signal (default true would keep junk entries)
    const hasSignal =
      Boolean(q.trim()) ||
      titleContains.length > 0 ||
      titleExcludes.length > 0 ||
      priceMin != null ||
      priceMax != null ||
      Boolean(merchantName)
    if (!hasSignal) continue
    out.push({
      id,
      name: name || defaultName({ q, titleContains, merchantName }),
      q,
      titleContains,
      titleExcludes,
      inStockOnly,
      priceMin,
      priceMax,
      merchantName,
      sort,
      sortDir,
      createdAt
    })
    if (out.length >= SAVED_SEARCHES_MAX) break
  }
  return out
}

function isSort(v: unknown): v is NonNullable<SearchQuery['sort']> {
  return (
    v === 'score' ||
    v === 'price' ||
    v === 'stock' ||
    v === 'fetchedAt' ||
    v === 'merchant' ||
    v === 'title'
  )
}

export function defaultName(s: {
  q: string
  titleContains?: string[]
  merchantName?: string
}): string {
  const parts = [s.q.trim(), ...(s.titleContains ?? []).map((t) => t.trim()).filter(Boolean)]
  if (s.merchantName?.trim()) parts.push(s.merchantName.trim())
  const name = parts.filter(Boolean).join(' · ')
  return name || '未命名搜索'
}

/** Prepend a new saved search; cap at SAVED_SEARCHES_MAX. */
export function pushSavedSearch(
  list: SavedSearch[] | null | undefined,
  snap: SavedSearchSnapshot,
  name?: string
): SavedSearch[] {
  const entry: SavedSearch = {
    id: newId(),
    name: (name?.trim() || defaultName(snap)).slice(0, 80),
    q: snap.q.trim(),
    titleContains: [...snap.titleContains],
    titleExcludes: [...snap.titleExcludes],
    inStockOnly: snap.inStockOnly,
    priceMin: snap.priceMin,
    priceMax: snap.priceMax,
    merchantName: snap.merchantName,
    sort: snap.sort,
    sortDir: snap.sortDir,
    createdAt: new Date().toISOString()
  }
  const rest = (list ?? []).filter((x) => x.id !== entry.id)
  return [entry, ...rest].slice(0, SAVED_SEARCHES_MAX)
}

export function removeSavedSearch(
  list: SavedSearch[] | null | undefined,
  id: string
): SavedSearch[] {
  return (list ?? []).filter((x) => x.id !== id)
}

export function renameSavedSearch(
  list: SavedSearch[] | null | undefined,
  id: string,
  name: string
): SavedSearch[] {
  const n = name.trim().slice(0, 80)
  if (!n) return list ? [...list] : []
  return (list ?? []).map((x) => (x.id === id ? { ...x, name: n } : x))
}
