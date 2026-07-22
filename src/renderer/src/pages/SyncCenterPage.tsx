import { useCallback, useEffect, useMemo, useState } from 'react'
import type {
  SyncHistoryStatusFilter,
  SyncHttpRequestEntry,
  SyncJobRecord,
  SyncProgressEvent
} from '@shared/types/sync'
import { SHOP_PROFILES } from '@shared/platforms/shop-profiles'
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
import {
  errorHint,
  formatDurationMs,
  formatElapsed,
  formatEta,
  formatJobUserMessage,
  formatSyncProgress,
  formatUserError,
  jobTypeLabel,
  parseShopProgressMessage,
  phaseLabel
} from '../lib/sync-labels'
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

const EXTRA_PLATFORM_LABEL: Record<string, string> = {
  dujiao: '独角数卡',
  yiciyuan: '异次元发卡',
  autopixel: 'AutoPixel'
}

/** 平台 id → 用户可读名称 */
function platformLabel(platformId?: string | null): string {
  if (!platformId) return ''
  const profile = SHOP_PROFILES.find((p) => p.id === platformId)
  if (profile) return profile.displayName
  return EXTRA_PLATFORM_LABEL[platformId] ?? platformId
}

/** 店铺标题：平台名 + token，不展示原始 platform:token */
function shopRefTitle(platformId?: string | null, token?: string | null): string {
  const name = platformLabel(platformId)
  const t = (token || '').trim()
  if (name && t) return `${name} · ${t}`
  if (t) return t
  if (name) return name
  return '未知店铺'
}

function shopErrorTitle(e: JobErrorEntry): string {
  return shopRefTitle(e.platformId, e.token)
}

interface LiveShopEvent {
  id: string
  kind: 'ok' | 'fail' | 'skip' | 'working'
  title: string
  detail?: string
  at: number
}

function JobDetailDialog({
  job,
  busy,
  onClose,
  onRetry,
  onCancel
}: {
  job: SyncJobRecord
  busy: boolean
  onClose: () => void
  onRetry: (errors: JobErrorEntry[]) => void
  onCancel: (jobId: string) => void
}): React.JSX.Element {
  return (
    <ModalDialog openKey={job.id} onClose={onClose}>
      <JobDetailBody job={job} busy={busy} onRetry={onRetry} onCancel={onCancel} />
    </ModalDialog>
  )
}

function JobDetailBody({
  job,
  busy,
  onRetry,
  onCancel
}: {
  job: SyncJobRecord
  busy: boolean
  onRetry: (errors: JobErrorEntry[]) => void
  onCancel: (jobId: string) => void
}): React.JSX.Element {
  const dismiss = useModalDismiss()
  const errors = jobErrors(job.meta)
  const failure = jobFailure(job.meta)
  const ok = metaNumber(job.meta, 'ok')
  const failed = metaNumber(job.meta, 'failed')
  const skippedFresh = metaNumber(job.meta, 'skippedFresh')
  const skippedDisabled = metaNumber(job.meta, 'skippedDisabled')
  const hint = errorHint(job.errorCode ?? failure?.code)
  const canRetry = errors.some((e) => e.merchantId)
  const summary = formatJobUserMessage(job)
  const active = job.status === 'running' || job.status === 'pending'
  const eta = active ? formatEta(job) : null
  const hasMetaCounts =
    ok != null ||
    failed != null ||
    (skippedFresh != null && skippedFresh > 0) ||
    (skippedDisabled != null && skippedDisabled > 0)
  const showProgress = active || job.total > 0
  const shopProgress = parseShopProgressMessage(job.message)

  const [nowTick, setNowTick] = useState(() => Date.now())
  const [requestLogs, setRequestLogs] = useState<SyncHttpRequestEntry[]>([])
  const [liveEvents, setLiveEvents] = useState<LiveShopEvent[]>([])

  useEffect(() => {
    if (!active) return
    const t = window.setInterval(() => setNowTick(Date.now()), 1000)
    return () => window.clearInterval(t)
  }, [active])

  // 订阅本任务的网络请求 → 只用于「还在联网」的用户可读提示
  useEffect(() => {
    let cancelled = false
    void window.api.sync.listRequestLogs().then((rows) => {
      if (!cancelled) setRequestLogs(rows.filter((e) => e.jobId === job.id))
    })
    const off = window.api.sync.onRequestLog((e) => {
      if (e.jobId !== job.id) return
      setRequestLogs((prev) => {
        const i = prev.findIndex((x) => x.id === e.id)
        if (i >= 0) {
          const next = prev.slice()
          next[i] = e
          return next
        }
        return [e, ...prev].slice(0, 120)
      })
    })
    return () => {
      cancelled = true
      off()
    }
  }, [job.id])

  // 进度 message 变化 → 滚动动态（完成/失败/跳过）
  useEffect(() => {
    const parsed = parseShopProgressMessage(job.message)
    if (!parsed) return
    if (parsed.kind === 'scraping' || parsed.kind === 'in_shop') return

    const id = `${parsed.kind}:${parsed.platformId}:${parsed.token}:${parsed.index}`
    const kind: LiveShopEvent['kind'] =
      parsed.kind === 'ok' ? 'ok' : parsed.kind === 'fail' ? 'fail' : 'skip'
    const detail = kind === 'ok' ? '同步成功' : kind === 'fail' ? '同步失败' : '已跳过'
    setLiveEvents((prev) => {
      if (prev.some((e) => e.id === id)) return prev
      return [
        {
          id,
          kind,
          title: shopRefTitle(parsed.platformId, parsed.token),
          detail,
          at: Date.now()
        },
        ...prev
      ].slice(0, 40)
    })
  }, [job.message])

  const elapsed = active ? formatElapsed(job.startedAt, nowTick) : null
  const endElapsed =
    !active && job.startedAt && job.finishedAt
      ? formatElapsed(job.startedAt, new Date(job.finishedAt).getTime())
      : null

  const phase = phaseLabel(job.phase)
  const statusText = STATUS_LABEL[job.status] ?? job.status

  // 当前正在处理的店（标题下大字）
  const currentShop =
    active && shopProgress && (shopProgress.kind === 'scraping' || shopProgress.kind === 'in_shop')
      ? shopRefTitle(shopProgress.platformId, shopProgress.token)
      : null
  const currentSub =
    active &&
    shopProgress?.kind === 'in_shop' &&
    shopProgress.subTotal != null &&
    shopProgress.subTotal > 0
      ? `店内 ${shopProgress.subCurrent}/${shopProgress.subTotal}`
      : null

  const headline = currentShop
    ? null
    : summary || (active && phase ? phase : '') || (active ? '同步进行中' : '')

  const whenLine = active
    ? [
        elapsed ? `已用 ${elapsed}` : null,
        eta,
        job.startedAt ? `开始于 ${timeAgo(job.startedAt)}` : null
      ]
        .filter(Boolean)
        .join(' · ')
    : [
        endElapsed ? `耗时 ${endElapsed}` : null,
        job.finishedAt
          ? `完成于 ${timeAgo(job.finishedAt)}`
          : job.startedAt
            ? `开始于 ${timeAgo(job.startedAt)}`
            : null
      ]
        .filter(Boolean)
        .join(' · ')

  // 运行中用动态事件统计；结束后用 meta
  const liveOk = liveEvents.filter((e) => e.kind === 'ok').length
  const liveFail = liveEvents.filter((e) => e.kind === 'fail').length
  const liveSkip = liveEvents.filter((e) => e.kind === 'skip').length
  const showLiveStats = active && (liveOk > 0 || liveFail > 0 || liveSkip > 0 || job.total > 0)

  const pendingRequests = useMemo(
    () => requestLogs.filter((e) => e.phase === 'pending'),
    [requestLogs]
  )
  const recentRequests = useMemo(
    () => requestLogs.filter((e) => e.phase !== 'pending').slice(0, 8),
    [requestLogs]
  )
  const showNetwork = active && (pendingRequests.length > 0 || requestLogs.length > 0)

  // 网络行：按 host 聚合进行中的
  const pendingByHost = useMemo(() => {
    const map = new Map<string, { host: string; startedAt: number; count: number }>()
    for (const e of pendingRequests) {
      const key = e.host || '未知站点'
      const cur = map.get(key)
      if (!cur) map.set(key, { host: key, startedAt: e.startedAt, count: 1 })
      else {
        cur.count += 1
        cur.startedAt = Math.min(cur.startedAt, e.startedAt)
      }
    }
    return [...map.values()].sort((a, b) => a.startedAt - b.startedAt)
  }, [pendingRequests])

  return (
    <>
      <div className="dialog-head">
        <ModalDialogTitle className="dialog-title">{jobTypeLabel(job.jobType)}</ModalDialogTitle>
        <IconButton label="关闭" autoFocus onClick={() => dismiss()}>
          <Icon name="close" />
        </IconButton>
      </div>
      <div className="dialog-body">
        <div className="job-detail-meter">
          <div className="row between" style={{ gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
            <StatusDot tone={statusTone(job.status)}>{statusText}</StatusDot>
            {showProgress && job.total > 0 ? (
              <span className="job-detail-count">
                <span className="num">{job.current}</span>
                <span className="muted"> / </span>
                <span className="num">{job.total}</span>
                <span className="muted"> 家</span>
              </span>
            ) : null}
          </div>

          {showProgress ? (
            <div className="job-detail-meter-bar">
              <Progress
                current={job.current}
                total={job.total}
                indeterminate={active && !job.total}
              />
            </div>
          ) : null}

          {currentShop ? (
            <div className="job-detail-current">
              <div className="job-detail-current-label muted small">正在同步</div>
              <div className="job-detail-current-title">{currentShop}</div>
              {currentSub ? (
                <div className="job-detail-current-sub muted small">{currentSub}</div>
              ) : phase ? (
                <div className="job-detail-current-sub muted small">{phase}</div>
              ) : null}
            </div>
          ) : headline ? (
            <div className="job-detail-headline">{headline}</div>
          ) : null}

          {whenLine ? <div className="job-detail-when muted small">{whenLine}</div> : null}
        </div>

        {showLiveStats ? (
          <div className="job-detail-block">
            <div className="lab">目前为止</div>
            <div className="job-detail-stats">
              <span className="job-stat">
                已处理 <span className="num">{job.current}</span>
                {job.total > 0 ? (
                  <>
                    <span className="muted"> / </span>
                    <span className="num">{job.total}</span>
                  </>
                ) : null}{' '}
                家
              </span>
              {liveOk > 0 ? (
                <span className="job-stat is-ok">
                  成功 <span className="num">{liveOk}</span>
                </span>
              ) : null}
              {liveFail > 0 ? (
                <span className="job-stat is-fail">
                  失败 <span className="num">{liveFail}</span>
                </span>
              ) : null}
              {liveSkip > 0 ? (
                <span className="job-stat">
                  跳过 <span className="num">{liveSkip}</span>
                </span>
              ) : null}
            </div>
          </div>
        ) : null}

        {hasMetaCounts && !active ? (
          <div className="job-detail-block">
            <div className="lab">结果</div>
            <div className="job-detail-stats">
              {ok != null ? (
                <span className="job-stat is-ok">
                  成功 <span className="num">{ok}</span> 家
                </span>
              ) : null}
              {failed != null && failed > 0 ? (
                <span className="job-stat is-fail">
                  失败 <span className="num">{failed}</span> 家
                </span>
              ) : null}
              {skippedFresh != null && skippedFresh > 0 ? (
                <span className="job-stat">
                  已是最新 <span className="num">{skippedFresh}</span> 家（跳过）
                </span>
              ) : null}
              {skippedDisabled != null && skippedDisabled > 0 ? (
                <span className="job-stat">
                  平台未启用 <span className="num">{skippedDisabled}</span> 家（跳过）
                </span>
              ) : null}
            </div>
          </div>
        ) : null}

        {active ? (
          <div className="job-detail-block">
            <div className="lab">实时动态</div>
            {currentShop || liveEvents.length > 0 ? (
              <ul className="job-live-list">
                {currentShop ? (
                  <li className="job-live-item is-working">
                    <span className="job-live-mark" aria-hidden>
                      …
                    </span>
                    <div className="job-live-body">
                      <div className="job-live-title">{currentShop}</div>
                      <div className="job-live-detail muted small">{currentSub ?? '同步中'}</div>
                    </div>
                  </li>
                ) : null}
                {liveEvents.map((e) => (
                  <li
                    key={e.id}
                    className={
                      e.kind === 'ok'
                        ? 'job-live-item is-ok'
                        : e.kind === 'fail'
                          ? 'job-live-item is-fail'
                          : 'job-live-item is-skip'
                    }
                  >
                    <span className="job-live-mark" aria-hidden>
                      {e.kind === 'ok' ? '✓' : e.kind === 'fail' ? '✗' : '–'}
                    </span>
                    <div className="job-live-body">
                      <div className="job-live-title">{e.title}</div>
                      <div className="job-live-detail muted small">
                        {e.detail}
                        {e.at ? ` · ${timeAgo(new Date(e.at).toISOString())}` : ''}
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
            ) : (
              <div className="job-live-empty muted small">
                {phase ? `${phase}…` : '正在启动，马上会有进度'}
              </div>
            )}
          </div>
        ) : null}

        {showNetwork ? (
          <div className="job-detail-block">
            <div className="lab">
              网络
              <span className="muted" style={{ fontWeight: 400 }}>
                {pendingRequests.length > 0
                  ? ` · 正在访问 ${pendingRequests.length} 处`
                  : ` · 本任务已请求 ${requestLogs.length} 次`}
              </span>
            </div>
            {pendingByHost.length > 0 ? (
              <ul className="job-net-list">
                {pendingByHost.map((h) => (
                  <li key={h.host} className="job-net-item is-pending">
                    <span className="job-net-host">{h.host}</span>
                    <span className="job-net-meta muted small">
                      连接中 · {formatDurationMs(nowTick - h.startedAt)}
                      {h.count > 1 ? ` · ${h.count} 个请求` : ''}
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <div className="muted small" style={{ marginTop: 6 }}>
                短暂空闲，等待下一家店…
              </div>
            )}
            {recentRequests.length > 0 && pendingByHost.length === 0 ? (
              <ul className="job-net-list job-net-list-recent">
                {recentRequests.slice(0, 4).map((e) => (
                  <li
                    key={e.id}
                    className={e.phase === 'error' ? 'job-net-item is-fail' : 'job-net-item'}
                  >
                    <span className="job-net-host">{e.host || '未知站点'}</span>
                    <span className="job-net-meta muted small">
                      {e.phase === 'error' ? '失败' : '完成'}
                      {' · '}
                      {formatDurationMs(
                        typeof e.durationMs === 'number'
                          ? e.durationMs
                          : e.endedAt
                            ? e.endedAt - e.startedAt
                            : 0
                      )}
                    </span>
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        ) : null}

        {hint ? (
          <div className="job-detail-block">
            <div className="lab">{job.status === 'cancelled' ? '说明' : '原因'}</div>
            <div className="job-detail-msg">{hint}</div>
          </div>
        ) : null}

        {errors.length > 0 ? (
          <div className="job-detail-block">
            <div className="lab">
              {canRetry ? '这些店没同步成功' : '失败明细'}
              <span className="muted" style={{ fontWeight: 400 }}>
                {' '}
                · {errors.length} 家
              </span>
            </div>
            <ul className="job-err-list">
              {errors.map((e, i) => {
                const reason = errorHint(e.code) ?? '出错了，请稍后重试'
                return (
                  <li key={`${e.platformId ?? ''}-${e.token}-${i}`} className="job-err-card">
                    <div className="job-err-title">{shopErrorTitle(e)}</div>
                    <div className="job-detail-msg">{reason}</div>
                  </li>
                )
              })}
            </ul>
          </div>
        ) : null}
      </div>
      {active || canRetry ? (
        <div className="dialog-actions">
          {active ? (
            <Button
              disabled={busy}
              onClick={() => {
                onCancel(job.id)
              }}
            >
              取消同步
            </Button>
          ) : null}
          {canRetry ? (
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
          ) : null}
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
    startShopAll,
    startShopSelected,
    cancelRunning,
    refresh,
    busy,
    anyRunning
  } =
    useSyncStatus()
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

  const pageCount = Math.max(1, Math.ceil(historyTotal / pageSize))
  const showPager = historyTotal > 0
  const canClear = historyTotal > 0 && statusFilter !== 'running'

  const scrapableMerchants = status?.counts.scrapableMerchants ?? status?.counts.ldxpMerchants ?? 0

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

  function retryFailed(errors: JobErrorEntry[]): void {
    const ids = [...new Set(errors.map((e) => e.merchantId).filter((v): v is string => !!v))]
    if (ids.length) {
      void startShopSelected(ids)
      toast(`已开始重试 ${ids.length} 家失败的店`)
    } else {
      toast('失败项没有关联商家 ID，无法批量重试', 'fail')
    }
  }

  async function cancelJob(jobId: string): Promise<void> {
    try {
      await window.api.sync.cancel(jobId)
      await refresh()
      await loadHistory()
      toast('已取消任务')
    } catch (err) {
      toast(formatUserError(err), 'fail')
    }
  }

  async function syncShops(force?: boolean): Promise<void> {
    if (!(await confirm(shopAllSpec(scrapableMerchants, force ? { force } : undefined)))) return
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

  // 优先前台任务进度；后台自动刷新并行时不抢条
  const foregroundRunning = (status?.running ?? []).filter((j) => j.meta?.background !== true)
  const runningJob =
    (progress &&
    (progress.status === 'running' || progress.status === 'pending') &&
    progress.background !== true
      ? progress
      : null) ??
    foregroundRunning[0] ??
    (progress?.status === 'running' || progress?.status === 'pending' ? progress : null) ??
    status?.running[0] ??
    null
  const liveDetailJob = useMemo(() => {
    if (!detailJob) return null
    const fromHistory = historyRows.find((j) => j.id === detailJob.id)
    const fromRunning = status?.running.find((j) => j.id === detailJob.id)
    // 只把匹配 jobId 的 progress 合入，避免后台任务事件改写前台详情
    const live =
      progress && progress.jobId === detailJob.id
        ? progress
        : progress && progress.jobId === (fromHistory ?? fromRunning)?.id
          ? progress
          : null
    return withLiveProgress(fromHistory ?? fromRunning ?? detailJob, live)
  }, [detailJob, historyRows, status?.running, progress])

  return (
    <div className="stack page-viewport">
      <PageHeader
        title="同步"
        meta="商家列表：PriceAI / NodeBits · 商品与平台识别：全局深刮 · 全部手动发起"
        actions={
          <>
            {busy ? <Button onClick={() => void cancelRunning()}>取消</Button> : null}
            <Button
              variant="primary"
              disabled={busy || scrapableMerchants === 0}
              onClick={() => void syncShops()}
            >
              增量同步店铺
            </Button>
            <Button
              disabled={busy || scrapableMerchants === 0}
              onClick={() => void syncShops(true)}
            >
              强制全量
            </Button>
          </>
        }
      />

      <div className="panel sync-top-panel" style={{ padding: '14px 16px' }}>
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
        {anyRunning && runningJob ? (
          <div className="stack" style={{ gap: 6, marginTop: 12 }}>
            <div className="row between" style={{ gap: 8, flexWrap: 'wrap' }}>
              <StatusDot tone="warn">
                {busy ? '同步中' : '后台刷新'}
                {(status?.running.length ?? 0) > 1
                  ? ` · ${status!.running.length} 个任务并行`
                  : ''}
              </StatusDot>
              <span className="small muted mono">
                {runningJob.current ?? 0}/{runningJob.total ?? 0}
                {runningJob.phase ? ` · ${phaseLabel(runningJob.phase)}` : ''}
              </span>
            </div>
            <Progress
              current={runningJob.current ?? 0}
              total={runningJob.total ?? 0}
              indeterminate={!runningJob.total}
            />
            <span className="small muted">{formatSyncProgress(runningJob)}</span>
          </div>
        ) : null}
      </div>

      <div className="panel panel-fill">
        <PanelHeader
          actions={
            <Button disabled={!canClear} onClick={() => void clearHistory()}>
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
            <div className="list-side">
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
                            {active ? formatSyncProgress(j) : formatJobUserMessage(j)}
                          </div>
                          {errors.length ? (
                            <div className="small muted">{errors.length} 家店失败 · 点开看明细</div>
                          ) : null}
                        </td>
                        <td className="small muted nowrap">{timeAgo(j.finishedAt || j.startedAt)}</td>
                        <td className="col-actions" onClick={(e) => e.stopPropagation()}>
                          {finished ? (
                            <IconButton
                              label="删除此记录"
                              className="row-actions"
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
            </div>
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
          onCancel={(jobId) => void cancelJob(jobId)}
        />
      ) : null}
    </div>
  )
}
