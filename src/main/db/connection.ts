import fs from 'node:fs'
import path from 'node:path'
import Database from 'better-sqlite3'
import { createLogger } from '../utils/logger'
import { migrate, readForeignKeysEnabled } from './migrate'

const log = createLogger('db')

export const DB_FILE_NAME = 'merchant-aggregator.db'

export interface OpenDatabaseOptions {
  /** Absolute path to the .db file, or ':memory:' for tests. */
  filePath: string
  readonly?: boolean
}

export interface OpenDatabaseResult {
  db: Database.Database
  filePath: string
  schemaVersion: number
  foreignKeys: boolean
}

function ensureParentDir(filePath: string): void {
  if (filePath === ':memory:') return
  const dir = path.dirname(filePath)
  fs.mkdirSync(dir, { recursive: true })
}

export function openDatabase(options: OpenDatabaseOptions): OpenDatabaseResult {
  const { filePath, readonly = false } = options
  ensureParentDir(filePath)

  log.info('opening database', { filePath, readonly })
  const db = new Database(filePath, { readonly, fileMustExist: false })

  // WAL is better for desktop app durability; skip for pure memory tests.
  if (filePath !== ':memory:') {
    db.pragma('journal_mode = WAL')
  }
  db.pragma('foreign_keys = ON')
  db.pragma('busy_timeout = 5000')

  const { to: schemaVersion } = migrate(db)
  const foreignKeys = readForeignKeysEnabled(db)

  if (!foreignKeys) {
    log.warn('PRAGMA foreign_keys is OFF after open')
  }

  return { db, filePath, schemaVersion, foreignKeys }
}

export function closeDatabase(db: Database.Database | null | undefined): void {
  if (!db) return
  try {
    db.close()
  } catch (err) {
    log.warn('error closing database', err)
  }
}

/** Resolve the production DB path under Electron userData. */
export function resolveUserDataDbPath(userDataPath: string): string {
  return path.join(userDataPath, DB_FILE_NAME)
}
