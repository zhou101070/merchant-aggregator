import { contextBridge } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'
import { createRendererApi } from './api'

const api = createRendererApi()

if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('electron', electronAPI)
    contextBridge.exposeInMainWorld('api', api)
  } catch (error) {
    console.error(error)
  }
} else {
  // @ts-expect-error legacy fallback when isolation is off
  window.electron = electronAPI
  // @ts-expect-error legacy fallback when isolation is off
  window.api = api
}
