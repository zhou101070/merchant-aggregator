import type Database from 'better-sqlite3'
import type { SyncJobRecord, SyncJobStatus, SyncJobType } from '@shared/types/sync'

interface SyncJobRow {
  id: string
  job_type: string
  status: string
  phase: string | null
  current: number
  total: number
  message: string | null
  error_code: string | null
  error_json: string | null
  started_at: string | null
  finished_at: string | null
  meta_json: string | null
}

function mapRow(row: SyncJobRow): SyncJobRecord {
  let meta: Record<string, unknown> | null = null
  if (row.meta_json) {
    try {
      meta = JSON.parse(row.meta_json) as Record<string, unknown>
    } catch {
      meta = null
    }
  }
  return {
    id: row.id,
    jobType: row.job_type as SyncJobType,
    status: row.status as SyncJobStatus,
    phase: row.phase,
    current: row.current,
    total: row.total,
    message: row.message,
    errorCode: row.error_code,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    meta
  }
}

export class SyncJobsRepo {
  constructor(private readonly db: Database.Database) {}

  insert(job: {
    id: string
    jobType: SyncJobType
    status: SyncJobStatus
    phase?: string | null
    current?: number
    total?: number
    message?: string | null
    startedAt?: string | null
    meta?: Record<string, unknown> | null
  }): void {
    this.db
      .prepare(
        `INSERT INTO sync_jobs (
          id, job_type, status, phase, current, total, message,
          error_code, error_json, started_at, finished_at, meta_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, NULL, ?)`
      )
      .run(
        job.id,
        job.jobType,
        job.status,
        job.phase ?? null,
        job.current ?? 0,
        job.total ?? 0,
        job.message ?? null,
        job.startedAt ?? null,
        job.meta ? JSON.stringify(job.meta) : null
      )
  }

  update(
    id: string,
    patch: {
      status?: SyncJobStatus
      phase?: string | null
      current?: number
      total?: number
      message?: string | null
      errorCode?: string | null
      finishedAt?: string | null
      meta?: Record<string, unknown> | null
    }
  ): void {
    const current = this.get(id)
    if (!current) return
    const next = {
      status: patch.status ?? current.status,
      phase: patch.phase !== undefined ? patch.phase : current.phase,
      current: patch.current ?? current.current,
      total: patch.total ?? current.total,
      message: patch.message !== undefined ? patch.message : current.message,
      errorCode: patch.errorCode !== undefined ? patch.errorCode : current.errorCode,
      finishedAt: patch.finishedAt !== undefined ? patch.finishedAt : current.finishedAt,
      meta: patch.meta !== undefined ? patch.meta : current.meta
    }
    this.db
      .prepare(
        `UPDATE sync_jobs SET
          status = ?, phase = ?, current = ?, total = ?, message = ?,
          error_code = ?, finished_at = ?, meta_json = ?
         WHERE id = ?`
      )
      .run(
        next.status,
        next.phase,
        next.current,
        next.total,
        next.message,
        next.errorCode,
        next.finishedAt,
        next.meta ? JSON.stringify(next.meta) : null,
        id
      )
  }

  get(id: string): SyncJobRecord | null {
    const row = this.db.prepare(`SELECT * FROM sync_jobs WHERE id = ?`).get(id) as
      SyncJobRow | undefined
    return row ? mapRow(row) : null
  }

  listRecent(limit = 20): SyncJobRecord[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM sync_jobs
         ORDER BY COALESCE(finished_at, started_at, '') DESC
         LIMIT ?`
      )
      .all(limit) as SyncJobRow[]
    return rows.map(mapRow)
  }

  listRunning(): SyncJobRecord[] {
    const rows = this.db
      .prepare(`SELECT * FROM sync_jobs WHERE status IN ('pending', 'running')`)
      .all() as SyncJobRow[]
    return rows.map(mapRow)
  }

  /** After process restart, in-memory jobs are gone — close DB leftovers. */
  cancelOrphanedRunning(reason = 'app restarted; previous sync interrupted'): number {
    const finishedAt = new Date().toISOString()
    const info = this.db
      .prepare(
        `UPDATE sync_jobs
         SET status = 'cancelled',
             message = COALESCE(message, ?),
             error_code = 'CANCELLED',
             finished_at = ?
         WHERE status IN ('pending', 'running')`
      )
      .run(reason, finishedAt)
    return info.changes
  }

  lastSuccessAt(): Partial<Record<SyncJobType, string>> {
    const rows = this.db
      .prepare(
        `SELECT job_type, MAX(finished_at) AS finished_at
         FROM sync_jobs
         WHERE status IN ('succeeded', 'partial') AND finished_at IS NOT NULL
         GROUP BY job_type`
      )
      .all() as { job_type: string; finished_at: string }[]
    const out: Partial<Record<SyncJobType, string>> = {}
    for (const r of rows) {
      out[r.job_type as SyncJobType] = r.finished_at
    }
    return out
  }
}
