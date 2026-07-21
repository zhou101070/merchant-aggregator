import { app, BrowserWindow, ipcMain, shell } from 'electron'
import { AppError } from '@shared/types/errors'
import { DB_SCHEMA_VERSION } from '@shared/constants'
import { IPC_CHANNELS } from '@shared/types/ipc'
import type { BlockTargetType } from '@shared/types/blocklist'
import type { FavoriteTargetType, FavoriteUpdateRequest } from '@shared/types/favorites'
import type { MerchantListQuery } from '@shared/types/merchant'
import type { RefreshStockRequest, ShopProductListQuery } from '@shared/types/product'
import type { SearchQuery } from '@shared/types/search'
import type { AppSettings } from '@shared/types/settings'
import type { SyncJobListQuery, SyncStartRequest } from '@shared/types/sync'
import type Database from 'better-sqlite3'
import type { Repositories } from '../db/repositories'
import type { SyncOrchestrator } from '../services/sync-orchestrator'
import type { SearchService } from '../services/search-service'
import { ProductStockService } from '../services/product-stock-service'
import { clearSyncHttpRequests, listSyncHttpRequests } from '../services/sync-request-log'
import { createLogger } from '../utils/logger'
import { evaluateOpenExternal } from '../utils/url-safety'
import { resolveUserDataDbPath } from '../db/connection'
import { clearAppData } from '../db/clear-app-data'
import { applyThemeSource } from '../theme'
import type { AutoRefreshScheduler } from '../services/auto-refresh-scheduler'

const log = createLogger('ipc')

export interface IpcContext {
  db: Database.Database
  repos: Repositories
  sync: SyncOrchestrator
  search: SearchService
  autoRefresh: AutoRefreshScheduler | null
}

function toIpcError(err: unknown): { code: string; message: string } {
  if (err instanceof AppError) return { code: err.code, message: err.message }
  return { code: 'INTERNAL', message: err instanceof Error ? err.message : String(err) }
}

const HANDLERS = Object.values(IPC_CHANNELS).filter(
  (c) => c !== IPC_CHANNELS.syncProgress && c !== IPC_CHANNELS.syncRequestLog
)

export function registerIpcHandlers(ctx: IpcContext): void {
  for (const ch of HANDLERS) {
    try {
      ipcMain.removeHandler(ch)
    } catch {
      // ignore
    }
  }

  const productStock = new ProductStockService(ctx.repos)

  ipcMain.handle(IPC_CHANNELS.merchantsList, async (_e, query: MerchantListQuery) =>
    ctx.repos.merchants.list(query)
  )
  ipcMain.handle(IPC_CHANNELS.merchantsGet, async (_e, req: { id: string }) =>
    ctx.repos.merchants.getById(req.id)
  )
  ipcMain.handle(IPC_CHANNELS.merchantsCandidates, async (_e, req: { q: string }) => {
    const settings = ctx.repos.settings.get()
    return ctx.repos.merchants.candidatesForQuery(req?.q ?? '', settings.shopFreshHours)
  })

  ipcMain.handle(IPC_CHANNELS.shopProductsList, async (_e, query: ShopProductListQuery) =>
    ctx.repos.shopProducts.list(query)
  )

  ipcMain.handle(IPC_CHANNELS.productsRefreshStock, async (_e, req: RefreshStockRequest) => {
    try {
      return await productStock.refresh(req)
    } catch (err) {
      const e = toIpcError(err)
      log.warn('products:refreshStock failed', e)
      throw new Error(`${e.code}: ${e.message}`)
    }
  })

  ipcMain.handle(IPC_CHANNELS.searchQuery, async (_e, req: SearchQuery) => ctx.search.query(req))

  ipcMain.handle(IPC_CHANNELS.syncStart, async (_e, req: SyncStartRequest) => {
    try {
      return ctx.sync.start(req)
    } catch (err) {
      const e = toIpcError(err)
      log.warn('sync:start failed', e)
      throw new Error(`${e.code}: ${e.message}`)
    }
  })
  ipcMain.handle(IPC_CHANNELS.syncCancel, async (_e, req: { jobId: string }) =>
    ctx.sync.cancel(req.jobId)
  )
  ipcMain.handle(IPC_CHANNELS.syncStatus, async () => ctx.sync.getStatus())
  ipcMain.handle(IPC_CHANNELS.syncListJobs, async (_e, query: SyncJobListQuery) =>
    ctx.repos.syncJobs.list(query ?? {})
  )
  ipcMain.handle(IPC_CHANNELS.syncDeleteJob, async (_e, req: { jobId: string }) =>
    ctx.repos.syncJobs.delete(req.jobId)
  )
  ipcMain.handle(IPC_CHANNELS.syncClearHistory, async () => ({
    deleted: ctx.repos.syncJobs.clearFinished()
  }))
  ipcMain.handle(IPC_CHANNELS.syncListRequestLogs, async () => listSyncHttpRequests())
  ipcMain.handle(IPC_CHANNELS.syncClearRequestLogs, async () => {
    clearSyncHttpRequests()
    return { ok: true as const }
  })
  ipcMain.handle(IPC_CHANNELS.syncGetPoolSnapshot, async (_e, req: { jobId: string }) =>
    ctx.sync.getPoolSnapshot(req.jobId)
  )

  ipcMain.handle(IPC_CHANNELS.favoritesList, async () => ctx.repos.favorites.list())
  ipcMain.handle(
    IPC_CHANNELS.favoritesAdd,
    async (
      _e,
      req: {
        targetType: FavoriteTargetType
        targetId: string
        note?: string
        targetPrice?: number | null
      }
    ) => ctx.repos.favorites.add(req)
  )
  ipcMain.handle(IPC_CHANNELS.favoritesUpdate, async (_e, req: FavoriteUpdateRequest) =>
    ctx.repos.favorites.update(req)
  )
  ipcMain.handle(
    IPC_CHANNELS.favoritesRemove,
    async (_e, req: { targetType: FavoriteTargetType; targetId: string }) =>
      ctx.repos.favorites.remove(req)
  )

  ipcMain.handle(IPC_CHANNELS.recentList, async (_e, limit?: number) =>
    ctx.repos.recent.list(limit)
  )
  ipcMain.handle(
    IPC_CHANNELS.recentTouch,
    async (_e, req: { targetType: string; targetId: string; titleSnapshot?: string }) =>
      ctx.repos.recent.touch(req)
  )

  ipcMain.handle(IPC_CHANNELS.blocklistList, async () => ctx.repos.blocklist.list())
  ipcMain.handle(
    IPC_CHANNELS.blocklistAdd,
    async (
      _e,
      req: { targetType: BlockTargetType; targetId: string; titleSnapshot?: string | null }
    ) => ctx.repos.blocklist.add(req)
  )
  ipcMain.handle(
    IPC_CHANNELS.blocklistRemove,
    async (_e, req: { targetType: BlockTargetType; targetId: string }) =>
      ctx.repos.blocklist.remove(req)
  )
  ipcMain.handle(IPC_CHANNELS.blocklistClear, async () => ctx.repos.blocklist.clear())

  ipcMain.handle(IPC_CHANNELS.settingsGet, async () => ctx.repos.settings.get())
  ipcMain.handle(IPC_CHANNELS.dataClearAll, async () => {
    const running = ctx.sync.getStatus().running
    if (running.length > 0) {
      throw new AppError('SYNC_LOCKED', '有同步任务进行中，请先取消或等待完成后再清空数据')
    }
    const result = clearAppData(ctx.db)
    log.info('app data cleared', { total: result.total, deleted: result.deleted })
    return result
  })
  ipcMain.handle(IPC_CHANNELS.settingsSet, async (_e, partial: Partial<AppSettings>) => {
    const next = ctx.repos.settings.set(partial)
    if (partial.theme !== undefined) {
      applyThemeSource(next.theme)
    }
    if (
      ctx.autoRefresh &&
      (partial.autoRefreshEnabled !== undefined ||
        partial.autoRefreshMinIntervalMs !== undefined ||
        partial.autoRefreshMaxIntervalMs !== undefined ||
        partial.shopFreshHours !== undefined)
    ) {
      ctx.autoRefresh.reschedule()
    }
    return next
  })

  ipcMain.handle(IPC_CHANNELS.shellOpenExternal, async (_e, req: { url: string }) => {
    const decision = evaluateOpenExternal(req.url)
    if (decision.action === 'reject') {
      throw new AppError('INVALID_URL', decision.reason)
    }
    await shell.openExternal(req.url)
    return { ok: true }
  })

  ipcMain.handle(IPC_CHANNELS.diagnosticsGet, async () => {
    const status = ctx.sync.getStatus()
    return {
      counts: status.counts,
      lastSuccessAt: status.lastSuccessAt,
      schemaVersion: DB_SCHEMA_VERSION,
      dbPath: resolveUserDataDbPath(app.getPath('userData')),
      version: app.getVersion(),
      priceSource: 'ldxp_shop_products',
      autoRefresh: ctx.autoRefresh?.status() ?? null
    }
  })

  function winFrom(e: Electron.IpcMainInvokeEvent): BrowserWindow | null {
    return BrowserWindow.fromWebContents(e.sender)
  }

  ipcMain.handle(IPC_CHANNELS.windowMinimize, async (e) => {
    winFrom(e)?.minimize()
  })
  ipcMain.handle(IPC_CHANNELS.windowMaximizeToggle, async (e) => {
    const w = winFrom(e)
    if (!w) return
    if (w.isMaximized()) w.unmaximize()
    else w.maximize()
  })
  ipcMain.handle(IPC_CHANNELS.windowClose, async (e) => {
    winFrom(e)?.close()
  })
  ipcMain.handle(IPC_CHANNELS.windowIsMaximized, async (e) => {
    return Boolean(winFrom(e)?.isMaximized())
  })
}
