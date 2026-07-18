import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type {
  ProxyBadNodeInfo,
  ProxyCallLogEntry,
  ProxyCoreDetail,
  ProxyCoreState,
  ProxyGroupInfo,
  ProxyNodeInfo
} from '@shared/types/proxy-core'
import { runDialogLeave } from '../lib/dialog-leave'
import { Icon } from './icons'
import { Badge, Button, Empty, IconButton, StatusDot, Switch, type Tone } from './ui'
import { useToast } from './use-toast'

function errMessage(e: unknown): string {
  if (e instanceof Error) return e.message
  return String(e)
}

function fmtTime(at: number): string {
  try {
    return new Date(at).toLocaleTimeString('zh-CN', { hour12: false })
  } catch {
    return String(at)
  }
}

function stateTone(state: ProxyCoreState): Tone {
  if (state === 'running') return 'ok'
  if (state === 'error') return 'fail'
  if (state === 'starting') return 'warn'
  return 'default'
}

function stateLabel(state: ProxyCoreState): string {
  switch (state) {
    case 'running':
      return '运行中'
    case 'starting':
      return '启动中'
    case 'error':
      return '异常'
    case 'stopped':
      return '已停止'
    default:
      return state
  }
}

function delayTone(ms: number | undefined): Tone {
  if (ms == null || ms <= 0) return 'default'
  if (ms < 200) return 'ok'
  if (ms < 500) return 'brass'
  if (ms < 1000) return 'warn'
  return 'fail'
}

function delayText(ms: number | undefined): string {
  if (ms == null || ms <= 0) return '—'
  return `${ms}ms`
}

function NodeRow({ n }: { n: ProxyNodeInfo }): React.JSX.Element {
  const tone = delayTone(n.delay)
  return (
    <li className="proxy-detail-node">
      <span className="proxy-detail-node-name" title={n.name}>
        {n.name}
      </span>
      <span className={`proxy-detail-node-delay tone-${tone}`}>{delayText(n.delay)}</span>
    </li>
  )
}

function GroupCard({ g }: { g: ProxyGroupInfo }): React.JSX.Element {
  const delays = g.nodes.map((n) => n.delay).filter((d): d is number => d != null && d > 0)
  const avg =
    delays.length > 0 ? Math.round(delays.reduce((a, b) => a + b, 0) / delays.length) : undefined

  return (
    <section className="proxy-detail-group">
      <header className="proxy-detail-group-head">
        <div className="proxy-detail-group-title">
          <span className="proxy-detail-group-name">{g.subscriptionName}</span>
          <span className="small muted" title={g.name}>
            {g.type}
          </span>
        </div>
        <div className="proxy-detail-group-meta">
          <Badge>{g.nodes.length} 节点</Badge>
          {avg != null ? <Badge tone={delayTone(avg)}>均 {avg}ms</Badge> : null}
        </div>
      </header>
      {g.nodes.length === 0 ? (
        <p className="proxy-detail-group-empty">暂无节点（内核未运行或订阅未拉取完成）</p>
      ) : (
        <ul className="proxy-detail-nodes">
          {g.nodes.map((n) => (
            <NodeRow key={n.name} n={n} />
          ))}
        </ul>
      )}
    </section>
  )
}

function BadNodeTable({ nodes }: { nodes: ProxyBadNodeInfo[] }): React.JSX.Element {
  return (
    <div className="proxy-detail-log-scroll">
      <table className="proxy-detail-log-table">
        <thead>
          <tr>
            <th>平台</th>
            <th>节点</th>
            <th>原因</th>
            <th>失效于</th>
          </tr>
        </thead>
        <tbody>
          {nodes.map((n) => (
            <tr key={`${n.platformId}:${n.nodeName}`}>
              <td className="tabular">{n.platformId}</td>
              <td title={n.nodeName}>{n.nodeName}</td>
              <td className="muted" title={n.reason ?? ''}>
                {n.reason ?? '—'}
              </td>
              <td className="muted tabular">
                {new Date(n.expiresAt).toLocaleString('zh-CN', { hour12: false })}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function LogTable({ logs }: { logs: ProxyCallLogEntry[] }): React.JSX.Element {
  return (
    <div className="proxy-detail-log-scroll">
      <table className="proxy-detail-log-table">
        <thead>
          <tr>
            <th>时间</th>
            <th>组</th>
            <th>节点</th>
            <th>目标</th>
          </tr>
        </thead>
        <tbody>
          {logs.map((e) => (
            <tr key={e.id}>
              <td className="muted tabular">{fmtTime(e.at)}</td>
              <td className="tabular" title={e.group}>
                {e.group.replace(/^MA-G-/, '')}
              </td>
              <td title={e.node}>{e.node}</td>
              <td className="muted" title={e.host}>
                {e.host}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

/**
 * 订阅详情：独立 dialog，仅在打开时挂载，关闭即卸载。
 * 不与商家/任务等 ModalDialog 共用壳，避免 modal 层互抢。
 */
export function ProxySubscriptionDialog({
  onClose,
  onCallLogChange
}: {
  onClose: () => void
  onCallLogChange?: (enabled: boolean) => void
}): React.JSX.Element {
  const toast = useToast()
  const dialogRef = useRef<HTMLDialogElement>(null)
  const leavingRef = useRef(false)
  const closedByUsRef = useRef(false)
  const onCloseRef = useRef(onClose)
  const [detail, setDetail] = useState<ProxyCoreDetail | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)

  useEffect(() => {
    onCloseRef.current = onClose
  }, [onClose])

  const reload = useCallback(async (soft = false) => {
    const api = window.api?.proxyCore
    if (!api || typeof api.detail !== 'function') {
      setError('接口未就绪：请完全退出并重启应用（仅刷新页面不够）')
      setLoading(false)
      return
    }
    if (!soft) setRefreshing(true)
    try {
      const d = await api.detail()
      setDetail(d)
      setError(null)
    } catch (e) {
      setError(errMessage(e))
    } finally {
      setLoading(false)
      setRefreshing(false)
    }
  }, [])

  // Mount → 延后 showModal；Unmount → 静默 close（不回调父级）
  useEffect(() => {
    const el = dialogRef.current
    if (!el) return
    let cancelled = false
    closedByUsRef.current = false
    leavingRef.current = false
    const t = window.setTimeout(() => {
      if (cancelled) return
      try {
        if (!el.open) el.showModal()
      } catch {
        el.setAttribute('open', '')
      }
      void reload()
    }, 0)

    return () => {
      cancelled = true
      window.clearTimeout(t)
      closedByUsRef.current = true
      leavingRef.current = false
      try {
        if (el.open) el.close()
      } catch {
        el.removeAttribute('open')
      }
    }
  }, [reload])

  useEffect(() => {
    const t = window.setInterval(() => void reload(true), 2000)
    return () => window.clearInterval(t)
  }, [reload])

  function finishClose(): void {
    leavingRef.current = false
    closedByUsRef.current = true
    const el = dialogRef.current
    if (el?.open) {
      try {
        el.close()
      } catch {
        el.removeAttribute('open')
      }
    }
    onCloseRef.current()
  }

  function dismiss(): void {
    if (leavingRef.current) return
    const el = dialogRef.current
    if (!el?.open) {
      onCloseRef.current()
      return
    }
    leavingRef.current = true
    runDialogLeave(el, finishClose)
  }

  async function toggleLog(v: boolean): Promise<void> {
    try {
      if (typeof window.api.proxyCore.setCallLogEnabled !== 'function') {
        throw new Error('接口未就绪，请重启应用')
      }
      await window.api.proxyCore.setCallLogEnabled(v)
      onCallLogChange?.(v)
      await reload(true)
    } catch (e) {
      toast(errMessage(e), 'fail')
    }
  }

  async function clearBadNodes(): Promise<void> {
    try {
      if (typeof window.api.proxyCore.clearBadNodes !== 'function') {
        throw new Error('接口未就绪，请重启应用')
      }
      await window.api.proxyCore.clearBadNodes()
      await reload(true)
      toast('已清空不可用节点记录', 'ok')
    } catch (e) {
      toast(errMessage(e), 'fail')
    }
  }

  async function clearLogs(): Promise<void> {
    try {
      if (typeof window.api.proxyCore.clearCallLogs !== 'function') {
        throw new Error('接口未就绪，请重启应用')
      }
      await window.api.proxyCore.clearCallLogs()
      await reload(true)
      toast('日志已清空', 'ok')
    } catch (e) {
      toast(errMessage(e), 'fail')
    }
  }

  const nodeTotal = useMemo(
    () => detail?.groups.reduce((n, g) => n + g.nodes.length, 0) ?? 0,
    [detail]
  )

  return createPortal(
    <dialog
      ref={dialogRef}
      className="dialog dialog-wide proxy-detail-dialog"
      onClose={() => {
        if (closedByUsRef.current) {
          closedByUsRef.current = false
          return
        }
        leavingRef.current = false
        onCloseRef.current()
      }}
      onCancel={(e) => {
        e.preventDefault()
        dismiss()
      }}
    >
      <div className="dialog-head">
        <div style={{ minWidth: 0, flex: 1 }}>
          <h2 className="dialog-title">订阅详情</h2>
        </div>
        <div className="proxy-detail-head-actions">
          <Button
            type="button"
            size="s"
            variant="ghost"
            disabled={refreshing}
            onClick={() => void reload()}
          >
            <Icon name="refresh" size={14} />
            刷新
          </Button>
          <IconButton label="关闭" onClick={dismiss}>
            <Icon name="close" />
          </IconButton>
        </div>
      </div>

      <div className="dialog-body proxy-detail-body">
        {detail ? (
          <>
            <div className="proxy-detail-status">
              <StatusDot tone={stateTone(detail.status.state)}>
                {stateLabel(detail.status.state)}
              </StatusDot>
              {detail.status.proxyUrl ? (
                <Badge tone="brass">{detail.status.proxyUrl.replace(/^https?:\/\//, '')}</Badge>
              ) : null}
              <Badge>{detail.groups.length} 组</Badge>
              <Badge>{nodeTotal} 节点</Badge>
              <Badge>load-balance</Badge>
            </div>
            {detail.status.message && detail.status.state !== 'running' ? (
              <p className="proxy-detail-status-msg">{detail.status.message}</p>
            ) : null}

            <section className="proxy-detail-section">
              <div className="proxy-detail-section-head">
                <h3 className="proxy-detail-section-title">订阅组</h3>
                <span className="small muted">每订阅一组 · 组内轮询</span>
              </div>
              {detail.groups.length === 0 ? (
                <Empty title="无启用订阅">在设置中添加并启用订阅后重试</Empty>
              ) : (
                <div className="proxy-detail-groups">
                  {detail.groups.map((g) => (
                    <GroupCard key={g.name} g={g} />
                  ))}
                </div>
              )}
            </section>

            {detail.badNodes.length > 0 ? (
              <section className="proxy-detail-section">
                <div className="proxy-detail-section-head">
                  <h3 className="proxy-detail-section-title">平台不可用节点</h3>
                  <div className="proxy-detail-log-toolbar">
                    <span className="small muted">换节点重试确证 · 到期自动恢复</span>
                    <Button type="button" size="s" variant="danger" onClick={() => void clearBadNodes()}>
                      清空
                    </Button>
                  </div>
                </div>
                <BadNodeTable nodes={detail.badNodes} />
              </section>
            ) : null}

            <section className="proxy-detail-section proxy-detail-log-section">
              <div className="proxy-detail-section-head">
                <h3 className="proxy-detail-section-title">调用日志</h3>
                <div className="proxy-detail-log-toolbar">
                  <label className="proxy-detail-log-switch">
                    <span className="small">记录</span>
                    <Switch
                      label="记录调用"
                      checked={detail.callLogEnabled}
                      onChange={(v) => void toggleLog(v)}
                    />
                  </label>
                  <Button
                    type="button"
                    size="s"
                    variant="danger"
                    disabled={detail.callLogs.length === 0}
                    onClick={() => void clearLogs()}
                  >
                    清空
                  </Button>
                </div>
              </div>
              <p className="proxy-detail-log-hint">
                轮询连接快照 · 内存最多约 300 条 · 关应用即清 · 极短连接可能漏记
              </p>
              {detail.callLogs.length === 0 ? (
                <div className="proxy-detail-log-empty">
                  <Empty title={detail.callLogEnabled ? '暂无记录' : '未开启记录'}>
                    {detail.callLogEnabled
                      ? '同步或请求经过内核后会出现在这里'
                      : '打开上方开关开始记录'}
                  </Empty>
                </div>
              ) : (
                <LogTable logs={detail.callLogs} />
              )}
            </section>
          </>
        ) : loading && !error ? (
          <div className="proxy-detail-loading">
            <span className="spin" aria-hidden="true" />
            <span className="muted">加载中…</span>
          </div>
        ) : error ? (
          <p className="small warn-text proxy-detail-error">{error}</p>
        ) : (
          <p className="muted">暂无数据</p>
        )}
      </div>
    </dialog>,
    document.body
  )
}
