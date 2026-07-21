/**
 * In-memory ring buffer of outbound HTTP calls during sync jobs.
 * Fed by mainFetch / shop page fetch; pushed to renderer for Sync Center.
 */
import { randomUUID } from 'node:crypto'
import { BrowserWindow } from 'electron'
import { IPC_CHANNELS } from '@shared/types/ipc'
import type { SyncHttpRequestEntry } from '@shared/types/sync'

const MAX_ENTRIES = 200

const activeJobIds = new Set<string>()
let primaryJobId: string | null = null
const entries: SyncHttpRequestEntry[] = []
const byId = new Map<string, SyncHttpRequestEntry>()

function emit(entry: SyncHttpRequestEntry): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue
    try {
      win.webContents.send(IPC_CHANNELS.syncRequestLog, entry)
    } catch {
      // ignore closed windows
    }
  }
}

function hostOf(url: string): string {
  try {
    return new URL(url).host || '—'
  } catch {
    return '—'
  }
}

function isLocalControllerHost(host: string): boolean {
  const h = host.toLowerCase()
  return (
    h === '127.0.0.1' ||
    h === 'localhost' ||
    h.startsWith('127.0.0.1:') ||
    h.startsWith('localhost:')
  )
}

function snapshot(): SyncHttpRequestEntry[] {
  return entries.slice()
}

/** Call when a sync job begins executing network work. */
export function enterSyncRequestScope(jobId: string): void {
  if (activeJobIds.size === 0) {
    entries.length = 0
    byId.clear()
  }
  activeJobIds.add(jobId)
  primaryJobId = jobId
}

/** Mark in-flight rows as ended so the UI does not stick on「连接中」. */
function settlePendingRequests(reason: string): void {
  for (const entry of entries) {
    if (entry.phase !== 'pending') continue
    endSyncHttpRequest(entry.id, { status: null, error: reason })
  }
}

/** Call when a sync job finishes (success/fail/cancel). */
export function leaveSyncRequestScope(jobId: string): void {
  activeJobIds.delete(jobId)
  if (primaryJobId === jobId) {
    primaryJobId = activeJobIds.size ? [...activeJobIds][0]! : null
  }
  // When no job is still scoped, close orphans (cancel / hang / race).
  if (activeJobIds.size === 0) {
    settlePendingRequests('请求未完成')
  }
}

export function isSyncRequestScopeActive(): boolean {
  return activeJobIds.size > 0
}

export function listSyncHttpRequests(): SyncHttpRequestEntry[] {
  return snapshot()
}

export function clearSyncHttpRequests(): void {
  entries.length = 0
  byId.clear()
}

export function beginSyncHttpRequest(opts: {
  method?: string
  url: string
  jobId?: string | null
}): string | null {
  if (!isSyncRequestScopeActive()) return null
  const url = opts.url
  const host = hostOf(url)
  if (isLocalControllerHost(host)) return null

  const id = randomUUID()
  const entry: SyncHttpRequestEntry = {
    id,
    jobId: opts.jobId ?? primaryJobId,
    method: (opts.method || 'GET').toUpperCase(),
    url,
    host,
    startedAt: Date.now(),
    node: '直连',
    phase: 'pending'
  }
  entries.unshift(entry)
  byId.set(id, entry)
  if (entries.length > MAX_ENTRIES) {
    const dropped = entries.splice(MAX_ENTRIES)
    for (const d of dropped) byId.delete(d.id)
  }
  emit(entry)
  return id
}

export function endSyncHttpRequest(
  id: string | null | undefined,
  result: { status?: number | null; error?: string | null; node?: string | null }
): void {
  if (!id) return
  const entry = byId.get(id)
  if (!entry || entry.phase !== 'pending') return
  const endedAt = Date.now()
  entry.endedAt = endedAt
  entry.durationMs = Math.max(0, endedAt - entry.startedAt)
  entry.status = result.status ?? null
  entry.error = result.error ?? null
  entry.phase = result.error && (result.status == null || result.status === 0) ? 'error' : 'done'
  if (result.node?.trim()) entry.node = result.node.trim()
  emit({ ...entry })
}
