/**
 * Smoke: open better-sqlite3 inside Electron and write a DB under userData.
 * Usage: pnpm exec electron scripts/smoke-db-electron.mjs
 */
import { app } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)

app.whenReady().then(() => {
  try {
    const Database = require('better-sqlite3')
    const dir = app.getPath('userData')
    const filePath = path.join(dir, 'merchant-aggregator.db')
    fs.mkdirSync(dir, { recursive: true })
    const db = new Database(filePath)
    db.pragma('foreign_keys = ON')
    const fk = db.pragma('foreign_keys', { simple: true })
    db.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL
      );
    `)
    if (Number(db.pragma('user_version', { simple: true })) < 1) {
      db.pragma('user_version = 1')
    }
    const userVersion = db.pragma('user_version', { simple: true })
    console.log(
      JSON.stringify({
        ok: true,
        filePath,
        exists: fs.existsSync(filePath),
        foreign_keys: Number(fk) === 1,
        user_version: userVersion
      })
    )
    db.close()
    app.exit(0)
  } catch (err) {
    console.error(JSON.stringify({ ok: false, error: String(err) }))
    app.exit(1)
  }
})
