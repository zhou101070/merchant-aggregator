import type Database from 'better-sqlite3'

export interface PlatformBadNode {
  id: number
  platformId: string
  nodeName: string
  reason: string | null
  createdAt: string
  expiresAt: string
}

type Row = {
  id: number
  platform_id: string
  node_name: string
  reason: string | null
  created_at: string
  expires_at: string
}

function mapRow(r: Row): PlatformBadNode {
  return {
    id: r.id,
    platformId: r.platform_id,
    nodeName: r.node_name,
    reason: r.reason,
    createdAt: r.created_at,
    expiresAt: r.expires_at
  }
}

/** Proxy nodes proven unusable for a platform; entries expire after a TTL. */
export class PlatformBadNodesRepo {
  constructor(private readonly db: Database.Database) {}

  /** Upsert: re-marking refreshes reason + expiry. */
  add(req: {
    platformId: string
    nodeName: string
    reason?: string | null
    ttlMs: number
  }): PlatformBadNode {
    const platformId = req.platformId.trim()
    const nodeName = req.nodeName.trim()
    if (!platformId || !nodeName) throw new Error('platformId and nodeName required')
    const now = Date.now()
    const createdAt = new Date(now).toISOString()
    const expiresAt = new Date(now + Math.max(0, req.ttlMs)).toISOString()
    this.db
      .prepare(
        `INSERT INTO platform_bad_nodes (platform_id, node_name, reason, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(platform_id, node_name) DO UPDATE SET
           reason = COALESCE(excluded.reason, platform_bad_nodes.reason),
           expires_at = excluded.expires_at`
      )
      .run(platformId, nodeName, req.reason?.trim() || null, createdAt, expiresAt)
    const row = this.db
      .prepare(
        `SELECT id, platform_id, node_name, reason, created_at, expires_at
         FROM platform_bad_nodes WHERE platform_id = ? AND node_name = ?`
      )
      .get(platformId, nodeName) as Row
    return mapRow(row)
  }

  /** Node names currently (non-expired) considered bad for a platform. */
  activeNodeNames(platformId: string): Set<string> {
    const rows = this.db
      .prepare(
        `SELECT node_name FROM platform_bad_nodes
         WHERE platform_id = ? AND expires_at > ?`
      )
      .all(platformId, new Date().toISOString()) as { node_name: string }[]
    return new Set(rows.map((r) => r.node_name))
  }

  /** All non-expired records (for UI). */
  listActive(): PlatformBadNode[] {
    const rows = this.db
      .prepare(
        `SELECT id, platform_id, node_name, reason, created_at, expires_at
         FROM platform_bad_nodes
         WHERE expires_at > ?
         ORDER BY platform_id ASC, created_at DESC`
      )
      .all(new Date().toISOString()) as Row[]
    return rows.map(mapRow)
  }

  purgeExpired(): { deleted: number } {
    const r = this.db
      .prepare(`DELETE FROM platform_bad_nodes WHERE expires_at <= ?`)
      .run(new Date().toISOString())
    return { deleted: r.changes }
  }

  clear(): { deleted: number } {
    const r = this.db.prepare(`DELETE FROM platform_bad_nodes`).run()
    return { deleted: r.changes }
  }
}
