import { useCallback, useEffect, useMemo, useState } from 'react'
import type {
  SyncHistoryStatusFilter,
  SyncHttpRequestEntry,
  SyncJobRecord,
  SyncProgressEvent
} from '@shared/types/sync'
import { isProductSyncActivity } from '@shared/types/sync'
import { Button, Empty, IconButton, Progress, StatusDot } from '../components/ui'
import { PageHeader, PanelHeader } from '../components/layout'
import { ModalDialog, ModalDialogTitle } from '../components/modal-dialog'
import { useModalDismiss } from '../components/use-modal-dismiss'
import { Pagination } from '../components/pagination'
import { Select } from '../components/select'
import { Icon } from '../components/icons'
import { useConfirm } from '../components/use-confirm'
import { useToast } from '../components/use-toast'
import { useSyncStatus } from '../hooks/useSync'
import { shopAllSpec } from '../lib/confirm-sync'
import { errorHint, formatSyncProgress, jobTypeLabel, phaseLabel } from '../lib/sync-labels'
import { timeAgo } from '../lib/format-time'

const HISTORY_PAGE_SIZE_OPTIONS = [10, 20, 50] as const
const DEFAULT_HISTORY_PAGE_SIZE = 20

const STATUS_LABEL: Record<string, string> = {
  queued: '排队',
  pending: '排队',
  running: '进行中',
  succeeded: '成功',
  failed: '失败',
  cancelled: '已取消',
  partial: '部分成功'
}

function statusTone(s: string): 'ok' | 'fail' | 'warn' | 'default' {
  if (s === 'succeeded') return 'ok'
  if (s === 'failed') return 'fail'
  if (s === 'running' || s === 'partial') return 'warn'
  return 'default'
}

interface JobErrorEntry {
  merchantId?: string | null
  platformId?: string | null
  token: string
  message: string
  code?: string | null
  details?: unknown
}

interface JobFailure {
  code?: string
  message?: string
  details?: unknown
}

function jobErrors(meta: Record<string, unknown> | null): JobErrorEntry[] {
  const raw = meta?.errors
  return Array.isArray(raw) ? (raw as JobErrorEntry[]) : []
}

function jobFailure(meta: Record<string, unknown> | null): JobFailure | null {
  const raw = meta?.failure
  if (!raw || typeof raw !== 'object') return null
  return raw as JobFailure
}

function formatAbs(iso: string | null | undefined): string {
  if (!iso) return '—'
  const t = new Date(iso)
  if (!Number.isFinite(t.getTime())) return iso
  return t.toLocaleString()
}

function formatDetails(details: unknown): string | null {
  if (details == null) return null
  if (typeof details === 'string') return details
  try {
    return JSON.stringify(details, null, 2)
  } catch {
    return String(details)
  }
}

function metaNumber(meta: Record<string, unknown> | null, key: string): number | null {
  const v = meta?.[key]
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

/** 用 IPC 实时 progress 覆盖历史快照中的进度字段 */
function withLiveProgress(job: SyncJobRecord, progress: SyncProgressEvent | null): SyncJobRecord {
  if (!progress || progress.jobId !== job.id) return job
  return {
    ...job,
    jobType: progress.jobType ?? job.jobType,
    phase: progress.phase ?? job.phase,
    current: progress.current,
    total: progress.total,
    message: progress.message ?? job.message,
    status: progress.status,
    errorCode: progress.errorCode ?? job.errorCode,
    startedAt: progress.startedAt ?? job.startedAt
  }
}

function progressToRecord(e: SyncProgressEvent): SyncJobRecord {
  return {
    id: e.jobId,
    jobType: e.jobType,
    status: e.status,
    phase: e.phase ?? null,
    current: e.current,
    total: e.total,
    message: e.message ?? null,
    errorCode: e.errorCode ?? null,
    startedAt: e.startedAt ?? null,
    finishedAt: null,
    meta: null
  }
}

function fmtRequestTime(ms: number): string {
  return new Date(ms).toLocaleTimeString('zh-CN', { hour12: false })
}

function fmtDurationMs(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '—'
  if (ms < 1000) return `${Math.round(ms)}ms`
  return `${(ms / 1000).toFixed(1)}s`
}

function requestDurationLabel(e: SyncHttpRequestEntry, now: number): string {
  if (e.phase === 'pending') return fmtDurationMs(now - e.startedAt)
  if (typeof e.durationMs === 'number') return fmtDurationMs(e.durationMs)
  if (e.endedAt) return fmtDurationMs(e.endedAt - e.startedAt)
  return '—'
}

function requestStatusLabel(e: SyncHttpRequestEntry): string {
  if (e.phase === 'pending') return '…'
  if (e.status != null && e.status > 0) return String(e.status)
  if (e.error) return 'ERR'
  return '—'
}

function shortUrl(url: string, max = 64): string {
  if (url.length <= max) return url
  return `${url.slice(0, max - 1)}…`
}

function SyncRequestLogTable({
  rows,
  nowTick,
  empty
}: {
  rows: SyncHttpRequestEntry[]
  nowTick: number
  empty?: string
}): React.JSX.Element {
  if (!rows.length) {
    return <div className="sync-request-log-empty muted small">{empty ?? '暂无'}</div>
  }
  return (
    <div className="sync-request-log-scroll">
      <table className="proxy-detail-log-table sync-request-log-table">
        <thead>
          <tr>
            <th>时间</th>
            <th>方法</th>
            <th>URL</th>
            <th>节点</th>
            <th>状态</th>
            <th>耗时</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((e) => (
            <tr key={e.id} className={e.phase === 'pending' ? 'is-pending' : undefined}>
              <td className="muted tabular">{fmtRequestTime(e.startedAt)}</td>
              <td className="tabular">{e.method}</td>
              <td className="muted" title={e.url}>
                {shortUrl(e.url, 72)}
              </td>
              <td title={e.node}>{e.node}</td>
              <td className="tabular" title={e.error ?? undefined}>
                {requestStatusLabel(e)}
              </td>
              <td className="tabular">{requestDurationLabel(e, nowTick)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function collectProductSyncJobs(
  running: SyncJobRecord[] | undefined,
  progress: SyncProgressEvent | null
): SyncJobRecord[] {
  const byId = new Map<string, SyncJobRecord>()
  for (const j of running ?? []) {
    const live = withLiveProgress(j, progress)
    if (isProductSyncActivity(live.jobType, live.phase)) {
      byId.set(live.id, live)
    }
  }
  if (
    progress &&
    (progress.status === 'running' || progress.status === 'pending') &&
    isProductSyncActivity(progress.jobType, progress.phase) &&
    !byId.has(progress.jobId)
  ) {
    byId.set(progress.jobId, progressToRecord(progress))
  }
  return [...byId.values()]
}

function JobDetailDialog({
  job,
  busy,
  onClose,
  onRetry
}: {
  job: SyncJobRecord
  busy: boolean
  onClose: () => void
  onRetry: (errors: JobErrorEntry[]) => void
}): React.JSX.Element {
  return (
    <ModalDialog openKey={job.id} onClose={onClose}>
      <JobDetailBody job={job} busy={busy} onRetry={onRetry} />
    </ModalDialog>
  )
}

function JobDetailBody({
  job,
  busy,
  onRetry
}: {
  job: SyncJobRecord
  busy: boolean
  onRetry: (errors: JobErrorEntry[]) => void
}): React.JSX.Element {
  const dismiss = useModalDismiss()
  const errors = jobErrors(job.meta)
  const failure = jobFailure(job.meta)
  const ok = metaNumber(job.meta, 'ok')
  const failed = metaNumber(job.meta, 'failed')
  const skippedFresh = metaNumber(job.meta, 'skippedFresh')
  const skippedDisabled = metaNumber(job.meta, 'skippedDisabled')
  const hint = errorHint(job.errorCode ?? failure?.code)
  const failureDetails = formatDetails(failure?.details)
  const canRetry = errors.some((e) => e.merchantId)

  return (
    <>
      <div className="dialog-head">
        <ModalDialogTitle className="dialog-title">
          {jobTypeLabel(job.jobType)} · 任务详情
        </ModalDialogTitle>
        <IconButton label="关闭" autoFocus onClick={() => dismiss()}>
          <Icon name="close" />
        </IconButton>
      </div>
      <div className="dialog-body">
        <div className="job-detail-grid">
          <span className="lab">状态</span>
          <span>
            <StatusDot tone={statusTone(job.status)}>
              {STATUS_LABEL[job.status] ?? job.status}
            </StatusDot>
          </span>
          <span className="lab">进度</span>
          <span>
            <div className="mono">
              {job.current}/{job.total}
              {job.phase ? ` · ${phaseLabel(job.phase)}` : ''}
            </div>
            {job.status === 'running' || job.status === 'pending' ? (
              <div style={{ marginTop: 8, maxWidth: 280 }}>
                <Progress current={job.current} total={job.total} indeterminate={!job.total} />
                <div className="small muted" style={{ marginTop: 6 }}>
                  {formatSyncProgress(job)}
                </div>
              </div>
            ) : null}
          </span>
          <span className="lab">开始</span>
          <span className="mono small">{formatAbs(job.startedAt)}</span>
          <span className="lab">结束</span>
          <span className="mono small">{formatAbs(job.finishedAt)}</span>
          <span className="lab">任务 ID</span>
          <span className="mono small">{job.id}</span>
        </div>

        {job.message ? (
          <div className="job-detail-block">
            <div className="lab">摘要</div>
            <div className="job-detail-msg">{job.message}</div>
          </div>
        ) : null}

        {(ok != null || failed != null || skippedFresh != null || skippedDisabled != null) && (
          <div className="job-detail-block">
            <div className="lab">统计</div>
            <div className="small">
              {[
                ok != null ? `成功 ${ok}` : null,
                failed != null ? `失败 ${failed}` : null,
                skippedFresh != null && skippedFresh > 0 ? `跳过新鲜 ${skippedFresh}` : null,
                skippedDisabled != null && skippedDisabled > 0
                  ? `跳过未启用平台 ${skippedDisabled}`
                  : null
              ]
                .filter(Boolean)
                .join(' · ')}
            </div>
          </div>
        )}

        {(job.errorCode || failure) && (
          <div className="job-detail-block">
            <div className="lab">任务级错误</div>
            <div className="job-err-card">
              <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
                {job.errorCode || failure?.code ? (
                  <span className="mono small">{job.errorCode || failure?.code}</span>
                ) : null}
                {hint ? <span className="small muted">{hint}</span> : null}
              </div>
              {failure?.message && failure.message !== job.message ? (
                <div className="job-detail-msg">{failure.message}</div>
              ) : null}
              {failureDetails ? <pre className="job-err-pre">{failureDetails}</pre> : null}
            </div>
          </div>
        )}

        {errors.length > 0 ? (
          <div className="job-detail-block">
            <div className="lab">店铺失败明细（{errors.length}）</div>
            <ul className="job-err-list">
              {errors.map((e, i) => {
                const d = formatDetails(e.details)
                const ref = e.platformId ? `${e.platformId}:${e.token}` : e.token
                return (
                  <li key={`${ref}-${i}`} className="job-err-card">
                    <div
                      className="row"
                      style={{ gap: 8, flexWrap: 'wrap', alignItems: 'baseline' }}
                    >
                      <span className="mono">{ref}</span>
                      {e.code ? <span className="mono small muted">{e.code}</span> : null}
                      {e.merchantId ? (
                        <span className="mono small muted">{e.merchantId}</span>
                      ) : null}
                    </div>
                    <div className="job-detail-msg">{e.message}</div>
                    {e.code ? <div className="small muted">{errorHint(e.code) ?? ''}</div> : null}
                    {d ? <pre className="job-err-pre">{d}</pre> : null}
                  </li>
                )
              })}
            </ul>
          </div>
        ) : null}

        {job.meta && Object.keys(job.meta).length > 0 ? (
          <details className="job-detail-raw">
            <summary>原始 meta</summary>
            <pre className="job-err-pre">{formatDetails(job.meta)}</pre>
          </details>
        ) : null}
      </div>
      {canRetry ? (
        <div className="dialog-actions">
          <Button
            variant="primary"
            disabled={busy}
            onClick={() => {
              onRetry(errors)
              dismiss()
            }}
          >
            重试失败的店
          </Button>
        </div>
      ) : null}
    </>
  )
}

export function SyncCenterPage(): React.JSX.Element {
  const {
    status,
    progress,
    start,
    startMerchants,
    startShopAll,
    startShopSelected,
    cancelRunning,
    refresh,
    busy,
    error
  } = useSyncStatus()
  const confirm = useConfirm()
  const toast = useToast()
  const [shopUrlInput, setShopUrlInput] = useState('')
  const [detailJob, setDetailJob] = useState<SyncJobRecord | null>(null)
  const [statusFilter, setStatusFilter] = useState<SyncHistoryStatusFilter>('all')
  const [page, setPage] = useState(0)
  const [pageSize, setPageSize] = useState(DEFAULT_HISTORY_PAGE_SIZE)
  const [historyRows, setHistoryRows] = useState<SyncJobRecord[]>([])
  const [historyTotal, setHistoryTotal] = useState(0)
  const [historyLoading, setHistoryLoading] = useState(false)
  const [requestLogs, setRequestLogs] = useState<SyncHttpRequestEntry[]>([])
  const [nowTick, setNowTick] = useState(() => Date.now())

  const pageCount = Math.max(1, Math.ceil(historyTotal / pageSize))
  const showPager = historyTotal > 0
  const canClear = historyTotal > 0 && statusFilter !== 'running'

  const scrapableMerchants = status?.counts.scrapableMerchants ?? status?.counts.ldxpMerchants ?? 0
  const [freshHours, setFreshHours] = useState(24)

  useEffect(() => {
    void window.api.settings.get().then((s) => {
      if (typeof s.shopFreshHours === 'number' && s.shopFreshHours > 0) {
        setFreshHours(s.shopFreshHours)
      }
    })
  }, [status?.running.length])

  const loadHistory = useCallback(async () => {
    setHistoryLoading(true)
    try {
      const res = await window.api.sync.listJobs({
        status: statusFilter,
        offset: page * pageSize,
        limit: pageSize
      })
      setHistoryRows(res.rows)
      setHistoryTotal(res.total)
      const maxPage = Math.max(0, Math.ceil(res.total / pageSize) - 1)
      if (page > maxPage) setPage(maxPage)
    } finally {
      setHistoryLoading(false)
    }
  }, [statusFilter, page, pageSize])

  useEffect(() => {
    void loadHistory()
  }, [loadHistory, status?.running.length, progress?.status])

  useEffect(() => {
    void window.api.sync.listRequestLogs().then(setRequestLogs)
    const off = window.api.sync.onRequestLog((e) => {
      setRequestLogs((prev) => {
        const i = prev.findIndex((x) => x.id === e.id)
        if (i >= 0) {
          const next = prev.slice()
          next[i] = e
          return next
        }
        return [e, ...prev].slice(0, 200)
      })
    })
    return off
  }, [])

  const pendingRequestLogs = useMemo(
    () => requestLogs.filter((e) => e.phase === 'pending'),
    [requestLogs]
  )
  const settledRequestLogs = useMemo(
    () => requestLogs.filter((e) => e.phase !== 'pending'),
    [requestLogs]
  )
  const hasPendingRequests = pendingRequestLogs.length > 0
  useEffect(() => {
    if (!hasPendingRequests) return
    const t = window.setInterval(() => setNowTick(Date.now()), 200)
    return () => window.clearInterval(t)
  }, [hasPendingRequests])

  async function clearRequestLogs(): Promise<void> {
    await window.api.sync.clearRequestLogs()
    setRequestLogs([])
  }

  function retryFailed(errors: JobErrorEntry[]): void {
    const ids = [...new Set(errors.map((e) => e.merchantId).filter((v): v is string => !!v))]
    if (ids.length) {
      void startShopSelected(ids)
      toast(`已开始重试 ${ids.length} 家失败的店`)
    } else {
      toast('失败项没有关联商家 ID，无法批量重试', 'fail')
    }
  }

  async function syncShops(force?: boolean): Promise<void> {
    if (!(await confirm(shopAllSpec(scrapableMerchants, force ? { force } : { freshHours })))) {
      return
    }
    void startShopAll(force)
  }

  function scrapeByUrl(): void {
    const url = shopUrlInput.trim()
    if (!url) {
      toast('请粘贴店铺 URL', 'fail')
      return
    }
    void start('shop_one', { shopUrl: url })
    toast('已提交单店同步')
  }

  async function deleteJob(jobId: string): Promise<void> {
    const res = await window.api.sync.deleteJob(jobId)
    if (!res.ok) {
      toast(res.reason === 'running' ? '进行中的任务不能删除' : '删除失败', 'fail')
      return
    }
    if (detailJob?.id === jobId) setDetailJob(null)
    await refresh()
    await loadHistory()
    toast('已删除该条历史', 'ok')
  }

  async function clearHistory(): Promise<void> {
    if (!canClear) return
    if (
      !(await confirm({
        title: '清空任务历史',
        body: `将删除全部已结束的任务记录（进行中的任务会保留）。此操作不可撤销。`,
        confirmLabel: '清空',
        danger: true
      }))
    ) {
      return
    }
    const res = await window.api.sync.clearHistory()
    setDetailJob(null)
    setPage(0)
    await refresh()
    await loadHistory()
    toast(res.deleted ? `已清空 ${res.deleted} 条历史` : '没有可清空的历史', 'ok')
  }

  function onStatusFilterChange(v: string): void {
    setStatusFilter(v as SyncHistoryStatusFilter)
    setPage(0)
  }

  function onHistoryPageSizeChange(size: number): void {
    setPageSize(size)
    setPage(0)
  }

  const lastByType = Object.entries(status?.lastSuccessAt ?? {}).filter(([, v]) => Boolean(v)) as [
    string,
    string
  ][]

  const productJobs = useMemo(
    () => collectProductSyncJobs(status?.running, progress),
    [status?.running, progress]
  )

  // 非商品任务（商家列表等）仍在统计区展示；商品走下方专用面板
  const otherRunningJob = useMemo(() => {
    const liveFromRunning = (status?.running ?? [])
      .map((j) => withLiveProgress(j, progress))
      .find((j) => !isProductSyncActivity(j.jobType, j.phase))
    if (liveFromRunning) return liveFromRunning
    if (
      progress &&
      (progress.status === 'running' || progress.status === 'pending') &&
      !isProductSyncActivity(progress.jobType, progress.phase)
    ) {
      return progressToRecord(progress)
    }
    return null
  }, [status?.running, progress])

  const liveDetailJob = detailJob ? withLiveProgress(detailJob, progress) : null

  async function cancelProductJob(jobId: string): Promise<void> {
    try {
      await window.api.sync.cancel(jobId)
      await refresh()
      toast('已取消商品同步')
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'fail')
    }
  }

  return (
    <div className="stack">
      <PageHeader
        title="同步"
        meta="商家来自 PriceAI · 价格来自发卡网深刮 · 支持手动同步与可选自动刷新"
        actions={
          busy ? (
            <Button onClick={() => void cancelRunning()}>
              <span className="spin" aria-hidden="true" />
              取消同步
            </Button>
          ) : (
            <>
              <Button onClick={() => void startMerchants()}>同步商家列表</Button>
              <Button
                variant="primary"
                disabled={scrapableMerchants === 0}
                onClick={() => void syncShops()}
                title={`只同步超过 ${freshHours} 小时未成功更新的店（设置里可改阈值）`}
              >
                同步旧数据店铺
              </Button>
              <Button
                disabled={scrapableMerchants === 0}
                onClick={() => void syncShops(true)}
                title="忽略缓存，重刮全部可深刮店"
              >
                强制全量
              </Button>
            </>
          )
        }
      />

      {error ? (
        <div className="panel" style={{ padding: '10px 14px' }}>
          <StatusDot tone="fail">{error}</StatusDot>
        </div>
      ) : null}

      <div className="panel" style={{ padding: '14px 16px' }}>
        <div className="row" style={{ gap: 8, flexWrap: 'wrap', marginBottom: 12 }}>
          <input
            className="input"
            style={{ flex: 1, minWidth: 240 }}
            placeholder="粘贴店铺 URL，例如 https://catfk.com/shop/hththt"
            value={shopUrlInput}
            onChange={(e) => setShopUrlInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') scrapeByUrl()
            }}
            disabled={busy}
          />
          <Button disabled={busy || !shopUrlInput.trim()} onClick={() => scrapeByUrl()}>
            同步此 URL
          </Button>
        </div>
        <div className="stat-line">
          <span>
            商家 <span className="num">{status?.counts.merchants ?? 0}</span>
          </span>
          <span className="sep">·</span>
          <span>
            可刮店铺 <span className="num">{scrapableMerchants}</span>
          </span>
          <span className="sep">·</span>
          <span>
            店内商品 <span className="num">{status?.counts.shopProducts ?? 0}</span>
          </span>
        </div>
        {lastByType.length ? (
          <div className="stat-sub">
            {lastByType.map(([k, v]) => `${jobTypeLabel(k)} 最近成功 ${timeAgo(v)}`).join(' · ')}
          </div>
        ) : (
          <div className="stat-sub">尚未有成功的同步任务</div>
        )}
        {otherRunningJob ? (
          <div className="stack" style={{ gap: 6, marginTop: 12 }}>
            <div className="row between" style={{ gap: 8, flexWrap: 'wrap' }}>
              <StatusDot tone="warn">{jobTypeLabel(otherRunningJob.jobType)}进行中</StatusDot>
              <span className="small muted mono">
                {otherRunningJob.current ?? 0}/{otherRunningJob.total ?? 0}
                {otherRunningJob.phase ? ` · ${phaseLabel(otherRunningJob.phase)}` : ''}
              </span>
            </div>
            <Progress
              current={otherRunningJob.current ?? 0}
              total={otherRunningJob.total ?? 0}
              indeterminate={!otherRunningJob.total}
            />
            <span className="small muted">{formatSyncProgress(otherRunningJob)}</span>
          </div>
        ) : null}
      </div>

      {productJobs.length > 0 ? (
        <div className="panel">
          <PanelHeader>
            <div className="row" style={{ gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
              <strong>商品同步</strong>
              <span className="sub">
                进行中 <span className="num">{productJobs.length}</span> · 实时更新
              </span>
            </div>
          </PanelHeader>
          <div className="product-sync-list">
            {productJobs.map((job) => {
              const active = job.status === 'running' || job.status === 'pending'
              return (
                <div
                  key={job.id}
                  className="product-sync-item"
                  role="button"
                  tabIndex={0}
                  onClick={() => setDetailJob(job)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault()
                      setDetailJob(job)
                    }
                  }}
                  aria-label={`查看 ${jobTypeLabel(job.jobType)} 商品同步详情`}
                >
                  <div className="row between" style={{ gap: 10, flexWrap: 'wrap' }}>
                    <div
                      className="row"
                      style={{ gap: 10, flexWrap: 'wrap', alignItems: 'center' }}
                    >
                      <StatusDot tone={statusTone(job.status)}>
                        {STATUS_LABEL[job.status] ?? job.status}
                      </StatusDot>
                      <strong>{jobTypeLabel(job.jobType)}</strong>
                      {job.phase ? (
                        <span className="small muted">{phaseLabel(job.phase)}</span>
                      ) : null}
                    </div>
                    <div className="row" style={{ gap: 8, alignItems: 'center' }}>
                      <span className="small muted mono">
                        {job.current}/{job.total}
                      </span>
                      {active ? (
                        <Button
                          onClick={(e) => {
                            e.stopPropagation()
                            void cancelProductJob(job.id)
                          }}
                        >
                          取消
                        </Button>
                      ) : null}
                    </div>
                  </div>
                  <div style={{ marginTop: 8 }}>
                    <Progress current={job.current} total={job.total} indeterminate={!job.total} />
                  </div>
                  <div className="product-sync-meta">
                    <div className="small muted">
                      {formatSyncProgress(job)}
                      {job.startedAt ? ` · 开始 ${timeAgo(job.startedAt)}` : ''}
                    </div>
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      ) : null}

      {busy || requestLogs.length > 0 ? (
        <div className="panel">
          <PanelHeader
            actions={
              <Button disabled={requestLogs.length === 0} onClick={() => void clearRequestLogs()}>
                清空请求
              </Button>
            }
          >
            <div className="row" style={{ gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
              <strong>同步请求</strong>
              <span className="sub">
                HTTP · 进行中 <span className="num">{pendingRequestLogs.length}</span>
                {settledRequestLogs.length > 0 ? (
                  <>
                    {' '}
                    · 已完成 <span className="num">{settledRequestLogs.length}</span>
                  </>
                ) : null}
              </span>
            </div>
          </PanelHeader>
          <div className="stack" style={{ gap: 12 }}>
            {pendingRequestLogs.length === 0 && settledRequestLogs.length === 0 ? (
              <Empty title="等待请求">
                任务已启动后，实际发出的 HTTP 请求会显示在这里（含代理节点与耗时）。
              </Empty>
            ) : (
              <>
                <div>
                  <div className="sync-request-section-label">进行中</div>
                  <SyncRequestLogTable
                    rows={pendingRequestLogs}
                    nowTick={nowTick}
                    empty={busy ? '暂无进行中的请求' : '无进行中的请求'}
                  />
                </div>
                {settledRequestLogs.length > 0 ? (
                  <details className="sync-request-settled">
                    <summary>
                      已完成 <span className="num">{settledRequestLogs.length}</span>
                    </summary>
                    <SyncRequestLogTable rows={settledRequestLogs} nowTick={nowTick} />
                  </details>
                ) : null}
              </>
            )}
          </div>
        </div>
      ) : null}

      <div className="panel">
        <PanelHeader
          actions={
            <Button variant="danger" disabled={!canClear} onClick={() => void clearHistory()}>
              清空历史
            </Button>
          }
        >
          <div className="row" style={{ gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
            <strong>任务历史</strong>
            <span className="sub">
              点击一行查看详情 · 共 <span className="num">{historyTotal}</span> 条
            </span>
            <Select
              value={statusFilter}
              onValueChange={onStatusFilterChange}
              ariaLabel="状态筛选"
              options={[
                { value: 'all', label: '全部状态' },
                { value: 'running', label: '进行中' },
                { value: 'succeeded', label: '成功' },
                { value: 'partial', label: '部分成功' },
                { value: 'failed', label: '失败' },
                { value: 'cancelled', label: '已取消' }
              ]}
            />
          </div>
        </PanelHeader>
        {!historyRows.length && !historyLoading ? (
          <Empty title={statusFilter === 'all' ? '还没有同步任务' : '没有符合筛选的任务'}>
            {statusFilter === 'all'
              ? '从上方发起第一次同步；任务进度、结果与错误都会记录在这里。'
              : '换一个状态筛选，或清空筛选查看全部。'}
          </Empty>
        ) : (
          <>
            <table className="table">
              <thead>
                <tr>
                  <th>任务</th>
                  <th>状态</th>
                  <th className="num">进度</th>
                  <th>信息</th>
                  <th>时间</th>
                  <th className="col-actions" />
                </tr>
              </thead>
              <tbody>
                {historyRows.map((raw) => {
                  const j = withLiveProgress(raw, progress)
                  const errors = jobErrors(j.meta)
                  const active = j.status === 'running' || j.status === 'pending'
                  const finished = !active
                  return (
                    <tr
                      key={j.id}
                      className="clickable"
                      onClick={() => setDetailJob(j)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault()
                          setDetailJob(j)
                        }
                      }}
                      tabIndex={0}
                      role="button"
                      aria-label={`查看 ${jobTypeLabel(j.jobType)} 任务详情`}
                    >
                      <td className="nowrap">{jobTypeLabel(j.jobType)}</td>
                      <td>
                        <StatusDot tone={statusTone(j.status)}>
                          {STATUS_LABEL[j.status] ?? j.status}
                        </StatusDot>
                      </td>
                      <td className="num mono">
                        {j.current}/{j.total}
                        {j.phase ? <div className="small muted">{phaseLabel(j.phase)}</div> : null}
                        {active ? (
                          <div style={{ marginTop: 6, minWidth: 80 }}>
                            <Progress
                              current={j.current}
                              total={j.total}
                              indeterminate={!j.total}
                            />
                          </div>
                        ) : null}
                      </td>
                      <td>
                        <div className="ellipsis" style={{ maxWidth: 360 }}>
                          {active ? formatSyncProgress(j) : j.message}
                        </div>
                        {j.errorCode ? (
                          <div className="small muted">{errorHint(j.errorCode)}</div>
                        ) : null}
                        {errors.length ? (
                          <div className="small muted">{errors.length} 家店失败 · 点开看明细</div>
                        ) : null}
                      </td>
                      <td className="small muted nowrap">{timeAgo(j.finishedAt || j.startedAt)}</td>
                      <td className="col-actions" onClick={(e) => e.stopPropagation()}>
                        {finished ? (
                          <IconButton
                            label="删除此记录"
                            className="row-actions icon-btn-danger"
                            onClick={() => void deleteJob(j.id)}
                          >
                            <Icon name="close" size={14} />
                          </IconButton>
                        ) : null}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
            {showPager ? (
              <Pagination
                page={page}
                pageCount={pageCount}
                total={historyTotal}
                pageSize={pageSize}
                pageSizeOptions={HISTORY_PAGE_SIZE_OPTIONS}
                disabled={historyLoading}
                onChange={setPage}
                onPageSizeChange={onHistoryPageSizeChange}
              />
            ) : null}
          </>
        )}
      </div>

      {liveDetailJob ? (
        <JobDetailDialog
          job={liveDetailJob}
          busy={busy}
          onClose={() => setDetailJob(null)}
          onRetry={retryFailed}
        />
      ) : null}
    </div>
  )
}
