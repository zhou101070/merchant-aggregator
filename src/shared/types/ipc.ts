import type { BlockedTarget, BlockTargetType } from './blocklist'
import type { Favorite, FavoriteTargetType, FavoriteUpdateRequest, RecentView } from './favorites'
import type { Merchant, MerchantCandidates, MerchantListQuery } from './merchant'
import type {
  RefreshStockRequest,
  RefreshStockResult,
  ShopProduct,
  ShopProductListQuery
} from './product'
import type { SearchQuery, SearchResult } from './search'
import type { AppSettings } from './settings'
import type {
  JobPoolSnapshot,
  SyncHttpRequestEntry,
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
  productsRefreshStock: 'products:refreshStock',
  searchQuery: 'search:query',
  syncStart: 'sync:start',
  syncCancel: 'sync:cancel',
  syncStatus: 'sync:status',
  syncProgress: 'sync:progress',
  /** main → renderer: single SyncHttpRequestEntry upsert */
  syncRequestLog: 'sync:requestLog',
  syncListRequestLogs: 'sync:listRequestLogs',
  syncClearRequestLogs: 'sync:clearRequestLogs',
  syncPoolSnapshot: 'sync:poolSnapshot',
  syncGetPoolSnapshot: 'sync:getPoolSnapshot',
  syncDeleteJob: 'sync:deleteJob',
  syncClearHistory: 'sync:clearHistory',
  syncListJobs: 'sync:listJobs',
  favoritesList: 'favorites:list',
  favoritesAdd: 'favorites:add',
  favoritesUpdate: 'favorites:update',
  favoritesRemove: 'favorites:remove',
  recentList: 'recent:list',
  recentTouch: 'recent:touch',
  blocklistList: 'blocklist:list',
  blocklistAdd: 'blocklist:add',
  blocklistRemove: 'blocklist:remove',
  blocklistClear: 'blocklist:clear',
  settingsGet: 'settings:get',
  settingsSet: 'settings:set',
  /** Wipe local business data (keeps settings). */
  dataClearAll: 'data:clearAll',
  shellOpenExternal: 'shell:openExternal',
  diagnosticsGet: 'diagnostics:get',
  /** Win 自绘窗控 */
  windowMinimize: 'window:minimize',
  windowMaximizeToggle: 'window:maximizeToggle',
  windowClose: 'window:close',
  windowIsMaximized: 'window:isMaximized',
  /** main → renderer: boolean */
  windowMaximized: 'window:maximized'
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
    refreshStock: (req: RefreshStockRequest) => Promise<RefreshStockResult>
  }
  search: {
    query: (req: SearchQuery) => Promise<SearchResult>
  }
  sync: {
    start: (req: SyncStartRequest) => Promise<{ jobId: string }>
    cancel: (jobId: string) => Promise<{ ok: boolean }>
    status: () => Promise<SyncStatus>
    listJobs: (q?: SyncJobListQuery) => Promise<SyncJobListResult>
    deleteJob: (jobId: string) => Promise<{ ok: boolean; reason?: string }>
    clearHistory: () => Promise<{ deleted: number }>
    listRequestLogs: () => Promise<SyncHttpRequestEntry[]>
    clearRequestLogs: () => Promise<{ ok: boolean }>
    getPoolSnapshot: (jobId: string) => Promise<JobPoolSnapshot | null>
    onProgress: (cb: (e: SyncProgressEvent) => void) => () => void
    onRequestLog: (cb: (e: SyncHttpRequestEntry) => void) => () => void
    onPoolSnapshot: (cb: (e: JobPoolSnapshot) => void) => () => void
  }
  favorites: {
    list: () => Promise<Favorite[]>
    add: (req: {
      targetType: FavoriteTargetType
      targetId: string
      note?: string
      targetPrice?: number | null
    }) => Promise<Favorite>
    update: (req: FavoriteUpdateRequest) => Promise<Favorite | null>
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
  blocklist: {
    list: () => Promise<BlockedTarget[]>
    add: (req: {
      targetType: BlockTargetType
      targetId: string
      titleSnapshot?: string | null
    }) => Promise<BlockedTarget>
    remove: (req: { targetType: BlockTargetType; targetId: string }) => Promise<{ ok: boolean }>
    clear: () => Promise<{ deleted: number }>
  }
  settings: {
    get: () => Promise<AppSettings>
    set: (p: Partial<AppSettings>) => Promise<AppSettings>
  }
  data: {
    /** Clear merchants / products / favorites / history / blocklist etc. Keeps settings. */
    clearAll: () => Promise<{ ok: true; total: number; deleted: Record<string, number> }>
  }
  shell: {
    openExternal: (url: string) => Promise<{ ok: boolean }>
  }
  diagnostics: {
    get: () => Promise<Record<string, unknown>>
  }
  window: {
    minimize: () => Promise<void>
    maximizeToggle: () => Promise<void>
    close: () => Promise<void>
    isMaximized: () => Promise<boolean>
    onMaximized: (cb: (maximized: boolean) => void) => () => void
  }
}
