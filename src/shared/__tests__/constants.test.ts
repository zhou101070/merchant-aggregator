import { describe, expect, it } from 'vitest'
import { DB_SCHEMA_VERSION, DEFAULT_APP_SETTINGS, SEARCH_DEFAULTS } from '../constants'
import { IPC_CHANNELS } from '../types/ipc'

describe('DEFAULT_APP_SETTINGS', () => {
  it('matches product defaults', () => {
    expect(DEFAULT_APP_SETTINGS.networkPaused).toBe(false)
    expect(DEFAULT_APP_SETTINGS.shopFreshMinutes).toBe(24 * 60)
    expect(DEFAULT_APP_SETTINGS.shopFreshUnit).toBe('hours')
    expect(DEFAULT_APP_SETTINGS.shopFreshHours).toBe(24)
    expect(DEFAULT_APP_SETTINGS.requestIntervalMs).toBe(500)
    expect(DEFAULT_APP_SETTINGS.shopPageConcurrency).toBe(1)
    expect(DEFAULT_APP_SETTINGS.theme).toBe('system')
    expect(DEFAULT_APP_SETTINGS.blockOnShopSyncFail).toBe(false)
    expect(DEFAULT_APP_SETTINGS.autoRefreshEnabled).toBe(false)
  })
})

describe('IPC_CHANNELS', () => {
  it('uses namespaced channel strings', () => {
    expect(IPC_CHANNELS.searchQuery).toBe('search:query')
    expect(IPC_CHANNELS.syncProgress).toBe('sync:progress')
    expect(IPC_CHANNELS.syncRequestLog).toBe('sync:requestLog')
    expect(IPC_CHANNELS.shellOpenExternal).toBe('shell:openExternal')
  })
})

describe('schema / search defaults', () => {
  it('schema version is current', () => {
    expect(DB_SCHEMA_VERSION).toBe(12)
  })

  it('defaults search page size to 50', () => {
    expect(SEARCH_DEFAULTS.limit).toBe(50)
  })
})
