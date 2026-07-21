import type Database from 'better-sqlite3'
import { clearSyncHttpRequests } from '../services/sync-request-log'

/** Business tables wiped by “一键清空数据”. Settings / schema_migrations kept. */
const CLEAR_TABLES = [
  'shop_products',
  'merchants',
  'favorites',
  'recent_views',
  'blocked_targets',
  'sync_jobs',
  'catalog_products',
  'offers'
] as const

export type ClearAppDataResult = {
  ok: true
  deleted: Record<string, number>
  total: number
}

/**
 * Wipe local business data. Does not touch app_settings or schema_migrations.
 * Call only when no sync job is running.
 */
export function clearAppData(db: Database.Database): ClearAppDataResult {
  const deleted: Record<string, number> = {}
  const existing = new Set(
    (
      db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all() as Array<{
        name: string
      }>
    ).map((r) => r.name)
  )

  const tx = db.transaction(() => {
    for (const table of CLEAR_TABLES) {
      if (!existing.has(table)) {
        deleted[table] = 0
        continue
      }
      const info = db.prepare(`DELETE FROM ${table}`).run()
      deleted[table] = info.changes
    }
  })
  tx()

  clearSyncHttpRequests()

  let total = 0
  for (const n of Object.values(deleted)) total += n
  return { ok: true, deleted, total }
}
