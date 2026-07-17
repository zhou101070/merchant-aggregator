import type Database from 'better-sqlite3'
import type { BlockedTarget, BlockTargetType } from '@shared/types/blocklist'

type Row = {
  id: number
  target_type: string
  target_id: string
  title_snapshot: string | null
  created_at: string
}

function mapRow(r: Row): BlockedTarget {
  return {
    id: r.id,
    targetType: r.target_type as BlockTargetType,
    targetId: r.target_id,
    titleSnapshot: r.title_snapshot,
    createdAt: r.created_at
  }
}

export class BlocklistRepo {
  constructor(private readonly db: Database.Database) {}

  list(): BlockedTarget[] {
    const rows = this.db
      .prepare(
        `SELECT id, target_type, target_id, title_snapshot, created_at
         FROM blocked_targets
         ORDER BY created_at DESC, id DESC`
      )
      .all() as Row[]
    return rows.map(mapRow)
  }

  /** Product ids (shop_products.id) and merchant ids currently blocked. */
  idSets(): { productIds: Set<string>; merchantIds: Set<string> } {
    const productIds = new Set<string>()
    const merchantIds = new Set<string>()
    const rows = this.db.prepare(`SELECT target_type, target_id FROM blocked_targets`).all() as {
      target_type: string
      target_id: string
    }[]
    for (const r of rows) {
      if (r.target_type === 'shop_product') productIds.add(r.target_id)
      else if (r.target_type === 'merchant') merchantIds.add(r.target_id)
    }
    return { productIds, merchantIds }
  }

  add(req: {
    targetType: BlockTargetType
    targetId: string
    titleSnapshot?: string | null
  }): BlockedTarget {
    const targetId = req.targetId.trim()
    if (!targetId) throw new Error('targetId required')
    if (req.targetType !== 'merchant' && req.targetType !== 'shop_product') {
      throw new Error('invalid targetType')
    }
    const now = new Date().toISOString()
    this.db
      .prepare(
        `INSERT INTO blocked_targets (target_type, target_id, title_snapshot, created_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(target_type, target_id) DO UPDATE SET
           title_snapshot = COALESCE(excluded.title_snapshot, blocked_targets.title_snapshot)`
      )
      .run(req.targetType, targetId, req.titleSnapshot?.trim() || null, now)
    const row = this.db
      .prepare(
        `SELECT id, target_type, target_id, title_snapshot, created_at
         FROM blocked_targets WHERE target_type = ? AND target_id = ?`
      )
      .get(req.targetType, targetId) as Row
    return mapRow(row)
  }

  remove(req: { targetType: BlockTargetType; targetId: string }): { ok: boolean } {
    const r = this.db
      .prepare(`DELETE FROM blocked_targets WHERE target_type = ? AND target_id = ?`)
      .run(req.targetType, req.targetId)
    return { ok: r.changes > 0 }
  }

  clear(): { deleted: number } {
    const r = this.db.prepare(`DELETE FROM blocked_targets`).run()
    return { deleted: r.changes }
  }
}
