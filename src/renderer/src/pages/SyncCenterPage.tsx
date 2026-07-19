import { useCallback, useEffect, useState } from 'react'
import type {
  SyncHistoryStatusFilter,
  SyncJobRecord,
  SyncProgressEvent
} from '@shared/types/sync'
import { Button, Empty, IconButton, Progress, StatusDot } from '../components/ui'
import { PageHeader, PanelHeader } from '../components/layout'
import { ModalDialog } from '../components/modal-dialog'
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
  formatJobUserMessage,
  formatSyncProgress,
  jobTypeLabel,
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

function formatAbs(iso: string | null | undefined): string {
  if (!iso) return '—'
  const t = new Date(iso)
  if (!Number.isFinite(t.getTime())) return iso
  return t.toLocaleString()
}

function metaNumber(meta: Record<string, unknown> | null, key: string): number | null {
  const v = meta?.[key]
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

/** 用 IPC 实时 progress 覆盖历史快照中的进度字段 */
function withLiveProgress(
  job: SyncJobRecord,
  progress: SyncProgressEvent | null
): SyncJobRecord {
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
  const canRetry = errors.some((e) => e.merchantId)
  const summary = formatJobUserMessage(job)

  return (
    <>
      <div className="dialog-head">
        <h2 className="dialog-title">{jobTypeLabel(job.jobType)} · 任务详情</h2>
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

        {summary ? (
          <div className="job-detail-block">
            <div className="lab">摘要</div>
            <div className="job-detail-msg">{summary}</div>
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

        {hint && !summary.includes(hint) ? (
          <div className="job-detail-block">
            <div className="lab">原因</div>
            <div className="job-detail-msg">{hint}</div>
          </div>
        ) : null}

        {errors.length > 0 ? (
          <div className="job-detail-block">
            <div className="lab">店铺失败明细（{errors.length}）</div>
            <ul className="job-err-list">
              {errors.map((e, i) => {
                const ref = e.platformId ? `${e.platformId}:${e.token}` : e.token
                const reason = errorHint(e.code) ?? '出错了，请稍后重试'
                return (
                  <li key={`${ref}-${i}`} className="job-err-card">
                    <div className="mono small">{ref}</div>
                    <div className="job-detail-msg">{reason}</div>
                  </li>
                )
              })}
            </ul>
          </div>
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

  // 与商家页一致：优先 IPC 实时 progress
  const runningJob = progress ?? status?.running[0] ?? null
  const liveDetailJob = detailJob ? withLiveProgress(detailJob, progress) : null

  return (
    <div className="stack">
      <PageHeader
        title="同步"
        meta="商家来自 PriceAI · 价格来自发卡网深刮 · 全部手动发起"
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
            <Button disabled={busy || scrapableMerchants === 0} onClick={() => void syncShops(true)}>
              强制全量
            </Button>
          </>
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
        {busy && runningJob ? (
          <div className="stack" style={{ gap: 6, marginTop: 12 }}>
            <div className="row between" style={{ gap: 8, flexWrap: 'wrap' }}>
              <StatusDot tone="warn">同步中</StatusDot>
              <span className="small muted mono">
                {(runningJob.current ?? 0)}/{(runningJob.total ?? 0)}
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

      <div className="panel">
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
                        {j.phase ? (
                          <div className="small muted">{phaseLabel(j.phase)}</div>
                        ) : null}
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
                      <td className="small muted nowrap">
                        {timeAgo(j.finishedAt || j.startedAt)}
                      </td>
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
