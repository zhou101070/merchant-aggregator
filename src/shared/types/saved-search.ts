import type { SearchQuery } from './search'

/** Persisted search snapshot (settings.savedSearches). */
export interface SavedSearch {
  id: string
  name: string
  q: string
  titleContains: string[]
  titleExcludes: string[]
  inStockOnly: boolean
  priceMin?: number
  priceMax?: number
  merchantName?: string
  sort: NonNullable<SearchQuery['sort']>
  sortDir: NonNullable<SearchQuery['sortDir']>
  createdAt: string
}
