import { useCallback, useEffect, useMemo, useState } from 'react'
import type {
  SyncJobRecord,
  SyncJobType,
  SyncProgressEvent,
  SyncStartRequest,
  SyncStatus
} from '@shared/types/sync'
import { useToast } from '../components/use-toast'
import { onDataCleared } from '../lib/data-events'
import { formatUserError } from '../lib/sync-labels'

export type SyncStartExtra = Omit<SyncStartRequest, 'jobType'>

/** 后台自动刷新任务：不锁 UI、取消前台时也不误杀 */
export function isBackgroundSyncJob(
  job: Pick<SyncJobRecord, 'meta'> | Pick<SyncProgressEvent, 'background'> | null | undefined
): boolean {
  if (!job) return false
  if ('background' in job && job.background === true) return true
  if ('meta' in job && job.meta && job.meta.background === true) return true
  return false
}

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
  /** 仅前台任务；后台自动刷新并行时不阻塞按钮 */
  busy: boolean
  /** 是否有任意任务（含后台）在跑，侧栏可显示活动 */
  anyRunning: boolean
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
      setProgress((prev) => {
        // 后台进度不覆盖前台进行中的进度，避免侧栏/忙碌态被自动刷新抢走
        if (
          e.background &&
          prev &&
          !prev.background &&
          (prev.status === 'running' || prev.status === 'pending') &&
          prev.jobId !== e.jobId
        ) {
          return prev
        }
        return e
      })
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

  const foregroundRunning = useMemo(
    () => (status?.running ?? []).filter((j) => !isBackgroundSyncJob(j)),
    [status?.running]
  )

  const progressActive =
    progress?.status === 'running' || progress?.status === 'pending' ? progress : null
  const progressForeground = progressActive && !isBackgroundSyncJob(progressActive)

  // 仅前台任务锁 UI；后台自动刷新可与用户任务并行
  const busy = foregroundRunning.length > 0 || !!progressForeground
  const anyRunning =
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
    // 只取消前台任务，保留后台自动刷新
    const jobs = (status?.running ?? []).filter((j) => !isBackgroundSyncJob(j))
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
    busy,
    anyRunning
  }
}
