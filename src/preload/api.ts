import { ipcRenderer } from 'electron'
import { IPC_CHANNELS, type RendererApi } from '@shared/types/ipc'
import type { JobPoolSnapshot, SyncHttpRequestEntry, SyncProgressEvent } from '@shared/types/sync'

export function createRendererApi(): RendererApi {
  return {
    merchants: {
      list: (q) => ipcRenderer.invoke(IPC_CHANNELS.merchantsList, q),
      get: (id) => ipcRenderer.invoke(IPC_CHANNELS.merchantsGet, { id }),
      candidates: (q) => ipcRenderer.invoke(IPC_CHANNELS.merchantsCandidates, { q })
    },
    shopProducts: {
      list: (q) => ipcRenderer.invoke(IPC_CHANNELS.shopProductsList, q)
    },
    products: {
      refreshStock: (req) => ipcRenderer.invoke(IPC_CHANNELS.productsRefreshStock, req)
    },
    search: {
      query: (req) => ipcRenderer.invoke(IPC_CHANNELS.searchQuery, req)
    },
    sync: {
      start: (req) => ipcRenderer.invoke(IPC_CHANNELS.syncStart, req),
      cancel: (jobId) => ipcRenderer.invoke(IPC_CHANNELS.syncCancel, { jobId }),
      status: () => ipcRenderer.invoke(IPC_CHANNELS.syncStatus),
      listJobs: (q) => ipcRenderer.invoke(IPC_CHANNELS.syncListJobs, q ?? {}),
      deleteJob: (jobId) => ipcRenderer.invoke(IPC_CHANNELS.syncDeleteJob, { jobId }),
      clearHistory: () => ipcRenderer.invoke(IPC_CHANNELS.syncClearHistory),
      listRequestLogs: () => ipcRenderer.invoke(IPC_CHANNELS.syncListRequestLogs),
      clearRequestLogs: () => ipcRenderer.invoke(IPC_CHANNELS.syncClearRequestLogs),
      getPoolSnapshot: (jobId) => ipcRenderer.invoke(IPC_CHANNELS.syncGetPoolSnapshot, { jobId }),
      onProgress: (cb) => {
        const listener = (_event: Electron.IpcRendererEvent, payload: SyncProgressEvent): void => {
          cb(payload)
        }
        ipcRenderer.on(IPC_CHANNELS.syncProgress, listener)
        return () => ipcRenderer.removeListener(IPC_CHANNELS.syncProgress, listener)
      },
      onRequestLog: (cb) => {
        const listener = (
          _event: Electron.IpcRendererEvent,
          payload: SyncHttpRequestEntry
        ): void => {
          cb(payload)
        }
        ipcRenderer.on(IPC_CHANNELS.syncRequestLog, listener)
        return () => ipcRenderer.removeListener(IPC_CHANNELS.syncRequestLog, listener)
      },
      onPoolSnapshot: (cb) => {
        const listener = (_event: Electron.IpcRendererEvent, payload: JobPoolSnapshot): void => {
          cb(payload)
        }
        ipcRenderer.on(IPC_CHANNELS.syncPoolSnapshot, listener)
        return () => ipcRenderer.removeListener(IPC_CHANNELS.syncPoolSnapshot, listener)
      }
    },
    favorites: {
      list: () => ipcRenderer.invoke(IPC_CHANNELS.favoritesList),
      add: (req) => ipcRenderer.invoke(IPC_CHANNELS.favoritesAdd, req),
      update: (req) => ipcRenderer.invoke(IPC_CHANNELS.favoritesUpdate, req),
      remove: (req) => ipcRenderer.invoke(IPC_CHANNELS.favoritesRemove, req)
    },
    recent: {
      list: (limit) => ipcRenderer.invoke(IPC_CHANNELS.recentList, limit),
      touch: (req) => ipcRenderer.invoke(IPC_CHANNELS.recentTouch, req)
    },
    blocklist: {
      list: () => ipcRenderer.invoke(IPC_CHANNELS.blocklistList),
      add: (req) => ipcRenderer.invoke(IPC_CHANNELS.blocklistAdd, req),
      remove: (req) => ipcRenderer.invoke(IPC_CHANNELS.blocklistRemove, req),
      clear: () => ipcRenderer.invoke(IPC_CHANNELS.blocklistClear)
    },
    settings: {
      get: () => ipcRenderer.invoke(IPC_CHANNELS.settingsGet),
      set: (p) => ipcRenderer.invoke(IPC_CHANNELS.settingsSet, p)
    },
    data: {
      clearAll: () => ipcRenderer.invoke(IPC_CHANNELS.dataClearAll)
    },
    shell: {
      openExternal: (url: string) => ipcRenderer.invoke(IPC_CHANNELS.shellOpenExternal, { url })
    },
    diagnostics: {
      get: () => ipcRenderer.invoke(IPC_CHANNELS.diagnosticsGet)
    },
    window: {
      minimize: () => ipcRenderer.invoke(IPC_CHANNELS.windowMinimize),
      maximizeToggle: () => ipcRenderer.invoke(IPC_CHANNELS.windowMaximizeToggle),
      close: () => ipcRenderer.invoke(IPC_CHANNELS.windowClose),
      isMaximized: () => ipcRenderer.invoke(IPC_CHANNELS.windowIsMaximized),
      onMaximized: (cb) => {
        const listener = (_e: Electron.IpcRendererEvent, maximized: boolean): void => {
          cb(Boolean(maximized))
        }
        ipcRenderer.on(IPC_CHANNELS.windowMaximized, listener)
        return () => ipcRenderer.removeListener(IPC_CHANNELS.windowMaximized, listener)
      }
    }
  }
}
