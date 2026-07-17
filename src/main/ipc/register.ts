import { app, ipcMain, shell } from 'electron'
import { AppError } from '@shared/types/errors'
import { DB_SCHEMA_VERSION } from '@shared/constants'
import { IPC_CHANNELS } from '@shared/types/ipc'
import type { FavoriteTargetType } from '@shared/types/favorites'
import type { MerchantListQuery } from '@shared/types/merchant'
import type { CompareRequest, ShopProductListQuery } from '@shared/types/product'
import type { SearchQuery } from '@shared/types/search'
import type { AppSettings } from '@shared/types/settings'
import type { SyncJobListQuery, SyncStartRequest } from '@shared/types/sync'
import type { Repositories } from '../db/repositories'
import type { SyncOrchestrator } from '../services/sync-orchestrator'
import type { SearchService } from '../services/search-service'
import { createLogger } from '../utils/logger'
import { evaluateOpenExternal } from '../utils/url-safety'
import { resolveUserDataDbPath } from '../db/connection'

const log = createLogger('ipc')

export interface IpcContext {
  repos: Repositories
  sync: SyncOrchestrator
  search: SearchService
}

function toIpcError(err: unknown): { code: string; message: string } {
  if (err instanceof AppError) return { code: err.code, message: err.message }
  return { code: 'INTERNAL', message: err instanceof Error ? err.message : String(err) }
}

const HANDLERS = Object.values(IPC_CHANNELS).filter((c) => c !== IPC_CHANNELS.syncProgress)

export function registerIpcHandlers(ctx: IpcContext): void {
  for (const ch of HANDLERS) {
    try {
      ipcMain.removeHandler(ch)
    } catch {
      // ignore
    }
  }

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

  ipcMain.handle(IPC_CHANNELS.productsCompare, async (_e, req: CompareRequest) =>
    ctx.search.compare(req)
  )

  ipcMain.handle(IPC_CHANNELS.searchQuery, async (_e, req: SearchQuery) => ctx.search.query(req))
  ipcMain.handle(IPC_CHANNELS.searchMeta, async () => ctx.search.meta())

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

  ipcMain.handle(IPC_CHANNELS.favoritesList, async () => ctx.repos.favorites.list())
  ipcMain.handle(
    IPC_CHANNELS.favoritesAdd,
    async (_e, req: { targetType: FavoriteTargetType; targetId: string; note?: string }) =>
      ctx.repos.favorites.add(req)
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

  ipcMain.handle(IPC_CHANNELS.settingsGet, async () => ctx.repos.settings.get())
  ipcMain.handle(IPC_CHANNELS.settingsSet, async (_e, partial: Partial<AppSettings>) =>
    ctx.repos.settings.set(partial)
  )

  ipcMain.handle(
    IPC_CHANNELS.shellOpenExternal,
    async (_e, req: { url: string; confirmed?: boolean }) => {
      const settings = ctx.repos.settings.get()
      const decision = evaluateOpenExternal(req.url, settings)
      if (decision.action === 'reject') {
        throw new AppError('INVALID_URL', decision.reason)
      }
      if (decision.action === 'confirm' && !req.confirmed) {
        return { ok: false, needsConfirm: true, host: decision.host }
      }
      await shell.openExternal(req.url)
      return { ok: true }
    }
  )

  ipcMain.handle(IPC_CHANNELS.diagnosticsGet, async () => {
    const status = ctx.sync.getStatus()
    return {
      counts: status.counts,
      lastSuccessAt: status.lastSuccessAt,
      schemaVersion: DB_SCHEMA_VERSION,
      dbPath: resolveUserDataDbPath(app.getPath('userData')),
      version: app.getVersion(),
      networkPaused: ctx.repos.settings.get().networkPaused,
      priceSource: 'ldxp_shop_products'
    }
  })
}
