/**
 * In-memory ring buffer of outbound HTTP calls during sync jobs.
 * Fed by mainFetch / shop page fetch; pushed to renderer for Sync Center.
 */
import { randomUUID } from 'node:crypto'
import { BrowserWindow } from 'electron'
import { IPC_CHANNELS } from '@shared/types/ipc'
import type { SyncHttpRequestEntry } from '@shared/types/sync'
import { getProxyCoreService } from './proxy-core-service'

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

function proxyCoreActive(): boolean {
  const core = getProxyCoreService()
  if (!core) return false
  const st = core.status()
  return st.state === 'running' && Boolean(st.proxyUrl)
}

function initialNodeLabel(): string {
  if (!proxyCoreActive()) return '直连'
  const pinned = getProxyCoreService()?.currentPinnedNode()
  if (pinned) return pinned
  return 'MA-LB'
}

function snapshot(): SyncHttpRequestEntry[] {
  return entries.slice()
}

/** Call when a sync job begins executing network work. */
export function enterSyncRequestScope(jobId: string): void {
  if (activeJobIds.size === 0) {
    entries.length = 0
    byId.clear()
    getProxyCoreService()?.startConnWatch()
  }
  activeJobIds.add(jobId)
  primaryJobId = jobId
}

/** Call when a sync job finishes (success/fail/cancel). */
export function leaveSyncRequestScope(jobId: string): void {
  activeJobIds.delete(jobId)
  if (primaryJobId === jobId) {
    primaryJobId = activeJobIds.size ? [...activeJobIds][0]! : null
  }
  if (activeJobIds.size === 0) {
    getProxyCoreService()?.stopConnWatch()
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
    node: initialNodeLabel(),
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
  result: { status?: number | null; error?: string | null }
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
  const pinned = getProxyCoreService()?.currentPinnedNode()
  if (pinned) entry.node = pinned
  emit({ ...entry })
  void refineNodeFromConnections(id, entry.host, entry.startedAt, endedAt)
}

async function refineNodeFromConnections(
  id: string,
  host: string,
  startedAt: number,
  endedAt: number
): Promise<void> {
  const core = getProxyCoreService()
  if (!core || !proxyCoreActive()) return
  try {
    const node = await core.resolveOutboundNode({ host, startedAt, endedAt })
    if (!node) return
    const entry = byId.get(id)
    if (!entry) return
    if (entry.node === node) return
    entry.node = node
    emit({ ...entry })
  } catch {
    // best-effort
  }
}
