import type Database from 'better-sqlite3'
import { DB_SCHEMA_VERSION } from '@shared/constants'
import { createLogger } from '../utils/logger'
import { SCHEMA_V1_SQL, SCHEMA_V2_SQL } from './schema.sql'

const log = createLogger('db:migrate')

function getUserVersion(db: Database.Database): number {
  const row = db.pragma('user_version', { simple: true }) as number
  return Number(row ?? 0)
}

function setUserVersion(db: Database.Database, version: number): void {
  db.pragma(`user_version = ${version}`)
}

function recordMigration(db: Database.Database, version: number): void {
  db.prepare(`INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (?, ?)`).run(
    version,
    new Date().toISOString()
  )
}

function addColumnIfMissing(
  db: Database.Database,
  table: string,
  column: string,
  typeSql: string
): void {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]
  if (cols.some((c) => c.name === column)) return
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${typeSql}`)
}

/** Apply pending migrations. Idempotent. */
export function migrate(db: Database.Database): { from: number; to: number } {
  const from = getUserVersion(db)
  let version = from

  if (version < 1) {
    log.info('applying schema v1')
    db.exec(SCHEMA_V1_SQL)
    recordMigration(db, 1)
    version = 1
  }

  if (version < 2) {
    log.info('applying schema v2 (drop offers/catalog)')
    db.exec(SCHEMA_V2_SQL)
    recordMigration(db, 2)
    version = 2
  }

  if (version < 3) {
    log.info('applying schema v3 (app health columns)')
    addColumnIfMissing(db, 'merchants', 'app_health_status', 'TEXT')
    addColumnIfMissing(db, 'merchants', 'app_health_at', 'TEXT')
    addColumnIfMissing(db, 'merchants', 'app_health_message', 'TEXT')
    // Backfill: already have shop products ⇒ healthy
    db.exec(`
      UPDATE merchants
      SET app_health_status = 'healthy',
          app_health_at = COALESCE(app_health_at, datetime('now'))
      WHERE (ldxp_token IS NOT NULL AND ldxp_token != '')
        AND (app_health_status IS NULL OR app_health_status = '')
        AND id IN (SELECT DISTINCT merchant_id FROM shop_products WHERE merchant_id IS NOT NULL)
    `)
    recordMigration(db, 3)
    version = 3
  }

  if (version < 4) {
    log.info('applying schema v4 (shop_platform / shop_token)')
    addColumnIfMissing(db, 'merchants', 'shop_platform', 'TEXT')
    addColumnIfMissing(db, 'merchants', 'shop_token', 'TEXT')
    // Backfill from legacy ldxp_token
    db.exec(`
      UPDATE merchants
      SET shop_platform = 'ldxp',
          shop_token = ldxp_token
      WHERE (ldxp_token IS NOT NULL AND ldxp_token != '')
        AND (shop_token IS NULL OR shop_token = '')
    `)
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_merchants_shop_ref
      ON merchants(shop_platform, shop_token)
    `)
    recordMigration(db, 4)
    version = 4
  }

  if (version !== from) {
    setUserVersion(db, version)
  }

  if (version !== DB_SCHEMA_VERSION) {
    throw new Error(`DB schema version mismatch: db=${version}, app expects ${DB_SCHEMA_VERSION}`)
  }

  log.info('migrations complete', { from, to: version })
  return { from, to: version }
}

export function readForeignKeysEnabled(db: Database.Database): boolean {
  const value = db.pragma('foreign_keys', { simple: true })
  return Number(value) === 1
}
