import { ipcRenderer } from 'electron'
import { IPC_CHANNELS, type RendererApi } from '@shared/types/ipc'
import type { SyncProgressEvent } from '@shared/types/sync'

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
      compare: (req) => ipcRenderer.invoke(IPC_CHANNELS.productsCompare, req)
    },
    search: {
      query: (req) => ipcRenderer.invoke(IPC_CHANNELS.searchQuery, req),
      meta: () => ipcRenderer.invoke(IPC_CHANNELS.searchMeta)
    },
    sync: {
      start: (req) => ipcRenderer.invoke(IPC_CHANNELS.syncStart, req),
      cancel: (jobId) => ipcRenderer.invoke(IPC_CHANNELS.syncCancel, { jobId }),
      status: () => ipcRenderer.invoke(IPC_CHANNELS.syncStatus),
      onProgress: (cb) => {
        const listener = (_event: Electron.IpcRendererEvent, payload: SyncProgressEvent): void => {
          cb(payload)
        }
        ipcRenderer.on(IPC_CHANNELS.syncProgress, listener)
        return () => ipcRenderer.removeListener(IPC_CHANNELS.syncProgress, listener)
      }
    },
    favorites: {
      list: () => ipcRenderer.invoke(IPC_CHANNELS.favoritesList),
      add: (req) => ipcRenderer.invoke(IPC_CHANNELS.favoritesAdd, req),
      remove: (req) => ipcRenderer.invoke(IPC_CHANNELS.favoritesRemove, req)
    },
    recent: {
      list: (limit) => ipcRenderer.invoke(IPC_CHANNELS.recentList, limit),
      touch: (req) => ipcRenderer.invoke(IPC_CHANNELS.recentTouch, req)
    },
    settings: {
      get: () => ipcRenderer.invoke(IPC_CHANNELS.settingsGet),
      set: (p) => ipcRenderer.invoke(IPC_CHANNELS.settingsSet, p)
    },
    shell: {
      openExternal: (url: string, opts?: { confirmed?: boolean }) =>
        ipcRenderer.invoke(IPC_CHANNELS.shellOpenExternal, {
          url,
          confirmed: opts?.confirmed
        })
    },
    diagnostics: {
      get: () => ipcRenderer.invoke(IPC_CHANNELS.diagnosticsGet)
    }
  }
}
