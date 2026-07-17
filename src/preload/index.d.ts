import { ElectronAPI } from '@electron-toolkit/preload'
import type { RendererApi } from '@shared/types/ipc'

declare global {
  interface Window {
    electron: ElectronAPI
    api: RendererApi
  }
}

export {}
