import type { Favorite, FavoriteTargetType, RecentView } from './favorites'
import type { Merchant, MerchantCandidates, MerchantListQuery } from './merchant'
import type { CompareRequest, CompareResult, ShopProduct, ShopProductListQuery } from './product'
import type { SearchMeta, SearchQuery, SearchResult } from './search'
import type { AppSettings } from './settings'
import type {
  SyncJobListQuery,
  SyncJobListResult,
  SyncProgressEvent,
  SyncStartRequest,
  SyncStatus
} from './sync'

export const IPC_CHANNELS = {
  merchantsList: 'merchants:list',
  merchantsGet: 'merchants:get',
  merchantsCandidates: 'merchants:candidates',
  shopProductsList: 'shopProducts:list',
  productsCompare: 'products:compare',
  searchQuery: 'search:query',
  searchMeta: 'search:meta',
  syncStart: 'sync:start',
  syncCancel: 'sync:cancel',
  syncStatus: 'sync:status',
  syncProgress: 'sync:progress',
  syncDeleteJob: 'sync:deleteJob',
  syncClearHistory: 'sync:clearHistory',
  syncListJobs: 'sync:listJobs',
  favoritesList: 'favorites:list',
  favoritesAdd: 'favorites:add',
  favoritesRemove: 'favorites:remove',
  recentList: 'recent:list',
  recentTouch: 'recent:touch',
  settingsGet: 'settings:get',
  settingsSet: 'settings:set',
  shellOpenExternal: 'shell:openExternal',
  diagnosticsGet: 'diagnostics:get'
} as const

export type IpcChannel = (typeof IPC_CHANNELS)[keyof typeof IPC_CHANNELS]

export interface RendererApi {
  merchants: {
    list: (q: MerchantListQuery) => Promise<{ rows: Merchant[]; total: number }>
    get: (id: string) => Promise<Merchant | null>
    /** 按关键词找"可能有货且待同步"的 ldxp 店 */
    candidates: (q: string) => Promise<MerchantCandidates>
  }
  shopProducts: {
    list: (q: ShopProductListQuery) => Promise<{ rows: ShopProduct[]; total: number }>
  }
  products: {
    compare: (req: CompareRequest) => Promise<CompareResult>
  }
  search: {
    query: (req: SearchQuery) => Promise<SearchResult>
    meta: () => Promise<SearchMeta>
  }
  sync: {
    start: (req: SyncStartRequest) => Promise<{ jobId: string }>
    cancel: (jobId: string) => Promise<{ ok: boolean }>
    status: () => Promise<SyncStatus>
    listJobs: (q?: SyncJobListQuery) => Promise<SyncJobListResult>
    deleteJob: (jobId: string) => Promise<{ ok: boolean; reason?: string }>
    clearHistory: () => Promise<{ deleted: number }>
    onProgress: (cb: (e: SyncProgressEvent) => void) => () => void
  }
  favorites: {
    list: () => Promise<Favorite[]>
    add: (req: {
      targetType: FavoriteTargetType
      targetId: string
      note?: string
    }) => Promise<Favorite>
    remove: (req: { targetType: FavoriteTargetType; targetId: string }) => Promise<{ ok: boolean }>
  }
  recent: {
    list: (limit?: number) => Promise<RecentView[]>
    touch: (req: {
      targetType: string
      targetId: string
      titleSnapshot?: string
    }) => Promise<{ ok: boolean }>
  }
  settings: {
    get: () => Promise<AppSettings>
    set: (p: Partial<AppSettings>) => Promise<AppSettings>
  }
  shell: {
    openExternal: (
      url: string,
      opts?: { confirmed?: boolean }
    ) => Promise<{ ok: boolean; needsConfirm?: boolean; host?: string }>
  }
  diagnostics: {
    get: () => Promise<Record<string, unknown>>
  }
}
