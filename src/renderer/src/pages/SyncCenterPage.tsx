import { useState } from 'react'
import { Button, Empty, Progress, StatusDot } from '../components/ui'
import { useConfirm } from '../components/use-confirm'
import { useToast } from '../components/use-toast'
import { useSyncStatus } from '../hooks/useSync'
import { shopAllSpec } from '../lib/confirm-sync'
import { errorHint, formatSyncProgress, jobTypeLabel } from '../lib/sync-labels'
import { timeAgo } from '../lib/format-time'

const STATUS_LABEL: Record<string, string> = {
  queued: '排队',
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
  token: string
  message: string
}

function jobErrors(meta: Record<string, unknown> | null): JobErrorEntry[] {
  const raw = meta?.errors
  return Array.isArray(raw) ? (raw as JobErrorEntry[]) : []
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
    busy,
    error
  } = useSyncStatus()
  const confirm = useConfirm()
  const toast = useToast()
  const [shopUrlInput, setShopUrlInput] = useState('')

  const scrapableMerchants = status?.counts.scrapableMerchants ?? status?.counts.ldxpMerchants ?? 0

  function retryFailed(errors: JobErrorEntry[]): void {
    const ids = [...new Set(errors.map((e) => e.merchantId).filter((v): v is string => !!v))]
    if (ids.length) {
      void startShopSelected(ids)
      toast(`已开始重试 ${ids.length} 家失败的店`)
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

  const lastByType = Object.entries(status?.lastSuccessAt ?? {}).filter(([, v]) => Boolean(v)) as [
    string,
    string
  ][]

  const runningJob = progress?.status === 'running' ? progress : status?.running[0]

  return (
    <div className="stack">
      <div className="page-head">
        <div>
          <h1 className="page-title">同步</h1>
          <div className="page-meta">商家来自 PriceAI · 价格来自发卡网深刮 · 全部手动发起</div>
        </div>
        <div className="page-actions">
          {busy ? <Button onClick={() => void cancelRunning()}>取消</Button> : null}
          <Button disabled={busy} onClick={() => void startMerchants()}>
            同步商家列表
          </Button>
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
        </div>
      </div>

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
        <div className="panel-head">
          <strong>任务历史</strong>
          <span className="sub">最近 {status?.recent?.length ?? 0} 条</span>
        </div>
        {!status?.recent?.length ? (
          <Empty title="还没有同步任务">
            从上方发起第一次同步；任务进度、结果与错误都会记录在这里。
          </Empty>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>任务</th>
                <th>状态</th>
                <th className="num">进度</th>
                <th>信息</th>
                <th>时间</th>
              </tr>
            </thead>
            <tbody>
              {(status?.recent ?? []).map((j) => {
                const errors = jobErrors(j.meta)
                return (
                  <tr key={j.id}>
                    <td className="nowrap">{jobTypeLabel(j.jobType)}</td>
                    <td>
                      <StatusDot tone={statusTone(j.status)}>
                        {STATUS_LABEL[j.status] ?? j.status}
                      </StatusDot>
                    </td>
                    <td className="num mono">
                      {j.current}/{j.total}
                      {j.status === 'running' ? (
                        <div style={{ marginTop: 6, minWidth: 80 }}>
                          <Progress current={j.current} total={j.total} indeterminate={!j.total} />
                        </div>
                      ) : null}
                    </td>
                    <td>
                      {j.message}
                      {j.errorCode ? (
                        <div className="small muted">{errorHint(j.errorCode)}</div>
                      ) : null}
                      {errors.length ? (
                        <details className="job-errors">
                          <summary>{errors.length} 家店失败</summary>
                          <ul>
                            {errors.map((e) => (
                              <li key={e.token}>
                                <span className="mono">{e.token}</span>:{e.message}
                              </li>
                            ))}
                          </ul>
                          <Button
                            size="s"
                            disabled={busy || !errors.some((e) => e.merchantId)}
                            onClick={() => retryFailed(errors)}
                          >
                            重试失败的店
                          </Button>
                        </details>
                      ) : null}
                    </td>
                    <td className="small muted nowrap">{timeAgo(j.finishedAt || j.startedAt)}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}
