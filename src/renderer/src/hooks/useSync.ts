import { useCallback, useEffect, useState } from 'react'
import type {
  SyncJobType,
  SyncProgressEvent,
  SyncStartRequest,
  SyncStatus
} from '@shared/types/sync'
import { useToast } from '../components/use-toast'
import { onDataCleared } from '../lib/data-events'
import { formatUserError } from '../lib/sync-labels'

export type SyncStartExtra = Omit<SyncStartRequest, 'jobType'>

export function useSyncStatus(): {
  status: SyncStatus | null
  progress: SyncProgressEvent | null
  refresh: () => Promise<void>
  start: (jobType: SyncJobType, extra?: SyncStartExtra) => Promise<void>
  startMerchants: () => Promise<void>
  startBootstrap: () => Promise<void>
  startShopAll: (force?: boolean) => Promise<void>
  startShopSelected: (merchantIds: string[]) => Promise<void>
  cancelRunning: () => Promise<void>
  busy: boolean
} {
  const toast = useToast()
  const [status, setStatus] = useState<SyncStatus | null>(null)
  const [progress, setProgress] = useState<SyncProgressEvent | null>(null)

  const refresh = useCallback(async () => {
    const s = await window.api.sync.status()
    setStatus(s)
  }, [])

  useEffect(() => {
    void refresh()
    const offProgress = window.api.sync.onProgress((e) => {
      setProgress(e)
      const terminal =
        e.status === 'succeeded' ||
        e.status === 'failed' ||
        e.status === 'cancelled' ||
        e.status === 'partial'
      // phase=shop fires at each shop start/end (not mid-product); keep counts fresh for list UIs
      const shopBoundary = e.status === 'running' && e.phase === 'shop'
      if (terminal || shopBoundary) {
        void refresh()
      }
    })
    const offCleared = onDataCleared(() => {
      setProgress(null)
      void refresh()
    })
    return () => {
      offProgress()
      offCleared()
    }
  }, [refresh])

  // status.running 仅在起停时刷新；进行中以 progress 为准，避免与商家页脱节
  const busy =
    (status?.running.length ?? 0) > 0 ||
    progress?.status === 'running' ||
    progress?.status === 'pending'

  const start = useCallback(
    async (jobType: SyncJobType, extra?: SyncStartExtra) => {
      try {
        await window.api.sync.start({ jobType, ...extra })
        await refresh()
      } catch (err) {
        // toast 4s 自动消失；避免页面内 sticky banner 一直挂着
        toast(formatUserError(err), 'fail')
      }
    },
    [refresh, toast]
  )

  const cancelRunning = useCallback(async () => {
    const jobs = status?.running ?? []
    if (!jobs.length) {
      await refresh()
      return
    }
    for (const job of jobs) {
      try {
        await window.api.sync.cancel(job.id)
      } catch {
        // continue cancelling others
      }
    }
    await refresh()
  }, [refresh, status])

  const startShopAll = (force?: boolean): Promise<void> =>
    start('shop_all', force ? { force } : undefined)
  const startShopSelected = (merchantIds: string[]): Promise<void> =>
    start('shop_selected', { merchantIds })

  return {
    status,
    progress,
    refresh,
    start,
    startMerchants: () => start('merchants'),
    startBootstrap: () => start('bootstrap'),
    startShopAll,
    startShopSelected,
    cancelRunning,
    busy
  }
}
