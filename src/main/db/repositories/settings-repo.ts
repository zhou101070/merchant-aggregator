import type Database from 'better-sqlite3'
import { DEFAULT_APP_SETTINGS } from '@shared/constants'
import {
  coalesceAppSettings,
  dualWriteSettingsPatch,
  type AppSettings
} from '@shared/types/settings'

const SETTINGS_KEY = 'app'

export class SettingsRepo {
  constructor(private readonly db: Database.Database) {}

  get(): AppSettings {
    const row = this.db
      .prepare(`SELECT value_json FROM app_settings WHERE key = ?`)
      .get(SETTINGS_KEY) as { value_json: string } | undefined

    if (!row) {
      return coalesceAppSettings(DEFAULT_APP_SETTINGS, null)
    }

    try {
      const parsed = JSON.parse(row.value_json) as Partial<AppSettings>
      return coalesceAppSettings(DEFAULT_APP_SETTINGS, parsed)
    } catch {
      return coalesceAppSettings(DEFAULT_APP_SETTINGS, null)
    }
  }

  set(partial: Partial<AppSettings>): AppSettings {
    const patched = dualWriteSettingsPatch(partial)
    const next = coalesceAppSettings(this.get(), patched)
    // ensure dual-fill on disk
    next.ldxpScrapeEnabled = next.shopScrapeEnabled
    next.ldxpMinIntervalMs = next.shopMinIntervalMs
    this.db
      .prepare(
        `INSERT INTO app_settings (key, value_json) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json`
      )
      .run(SETTINGS_KEY, JSON.stringify(next))
    return next
  }
}
