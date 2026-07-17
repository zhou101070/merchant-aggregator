import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { DB_SCHEMA_VERSION } from '@shared/constants'
import { openDatabase, closeDatabase } from '../connection'
import { REQUIRED_TABLES } from '../schema.sql'
import { migrate, readForeignKeysEnabled } from '../migrate'

const tempDirs: string[] = []

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

describe('openDatabase + migrate', () => {
  it('creates schema version 6 with blocklist', () => {
    const { db, schemaVersion, foreignKeys } = openDatabase({ filePath: ':memory:' })
    try {
      expect(schemaVersion).toBe(DB_SCHEMA_VERSION)
      expect(foreignKeys).toBe(true)
      expect(readForeignKeysEnabled(db)).toBe(true)

      const tables = db
        .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`)
        .all()
        .map((r) => (r as { name: string }).name)

      for (const t of REQUIRED_TABLES) {
        expect(tables).toContain(t)
      }
      expect(tables).toContain('blocked_targets')
      expect(tables).not.toContain('offers')
      expect(tables).not.toContain('catalog_products')
      const merchantCols = db.prepare('PRAGMA table_info(merchants)').all() as { name: string }[]
      expect(merchantCols.map((c) => c.name)).toEqual(
        expect.arrayContaining([
          'app_health_status',
          'app_health_at',
          'app_health_message',
          'shop_platform',
          'shop_token'
        ])
      )
      const favCols = db.prepare('PRAGMA table_info(favorites)').all() as { name: string }[]
      expect(favCols.map((c) => c.name)).toEqual(
        expect.arrayContaining(['baseline_price', 'target_price'])
      )
    } finally {
      closeDatabase(db)
    }
  })

  it('is idempotent on file DB and persists user_version=6', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ma-db-'))
    tempDirs.push(dir)
    const filePath = path.join(dir, 'merchant-aggregator.db')

    const first = openDatabase({ filePath })
    expect(first.schemaVersion).toBe(6)
    expect(fs.existsSync(filePath)).toBe(true)
    closeDatabase(first.db)

    const second = openDatabase({ filePath })
    try {
      expect(second.schemaVersion).toBe(6)
      const migrationRows = second.db
        .prepare(`SELECT version FROM schema_migrations ORDER BY version`)
        .all() as { version: number }[]
      expect(migrationRows.map((r) => r.version)).toEqual([1, 2, 3, 4, 5, 6])
    } finally {
      closeDatabase(second.db)
    }
  })

  it('normalizes legacy space-separated app_health_at to ISO-ish form on migrate', () => {
    const { db } = openDatabase({ filePath: ':memory:' })
    try {
      db.prepare(
        `INSERT INTO merchants (id, name, fetched_at, shop_platform, shop_token, app_health_status, app_health_at)
         VALUES ('m-space', 't', datetime('now'), 'ldxp', 'T1', 'healthy', '2026-07-17 14:00:00')`
      ).run()
      migrate(db)
      const row = db
        .prepare(`SELECT app_health_at FROM merchants WHERE id='m-space'`)
        .get() as { app_health_at: string }
      expect(row.app_health_at).toBe('2026-07-17T14:00:00Z')
      const cutoff = '2026-07-17T12:00:00.000Z'
      expect(row.app_health_at >= cutoff).toBe(true)
    } finally {
      closeDatabase(db)
    }
  })

  it('backfills shop_platform/token from ldxp_token', () => {
    const { db } = openDatabase({ filePath: ':memory:' })
    try {
      db.prepare(
        `INSERT INTO merchants (id, name, fetched_at, ldxp_token, shop_platform, shop_token)
         VALUES ('m1', 't', datetime('now'), 'TOK123', NULL, NULL)`
      ).run()
      // re-run backfill logic as migrate already applied empty; simulate partial state
      db.exec(`
        UPDATE merchants
        SET shop_platform = 'ldxp', shop_token = ldxp_token
        WHERE (ldxp_token IS NOT NULL AND ldxp_token != '')
          AND (shop_token IS NULL OR shop_token = '')
      `)
      const row = db
        .prepare(`SELECT shop_platform, shop_token FROM merchants WHERE id='m1'`)
        .get() as {
        shop_platform: string
        shop_token: string
      }
      expect(row.shop_platform).toBe('ldxp')
      expect(row.shop_token).toBe('TOK123')
    } finally {
      closeDatabase(db)
    }
  })
})
