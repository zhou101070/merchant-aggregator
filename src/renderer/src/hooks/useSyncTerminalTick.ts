import type { SyncProgressEvent } from '@shared/types/sync'

const TERMINAL = new Set(['succeeded', 'failed', 'partial', 'cancelled'])

/**
 * Stable key when a sync job reaches a terminal status.
 * Use as a useEffect dependency to reload lists after sync settles.
 */
export function useSyncTerminalTick(progress: SyncProgressEvent | null | undefined): string {
  if (progress && TERMINAL.has(progress.status)) {
    return `${progress.jobId}:${progress.status}`
  }
  return ''
}
