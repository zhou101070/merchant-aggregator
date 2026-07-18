import { useCallback, useEffect, useState } from 'react'
import type { BlockedTarget } from '@shared/types/blocklist'
import { AUTO_REFRESH_LIMITS, SHOP_API_LIMITS } from '@shared/constants'
import type { ProxyCoreState, ProxyCoreStatus } from '@shared/types/proxy-core'
import type { AppSettings, ThemeMode } from '@shared/types/settings'
import {
  isAllowedProxySubscriptionUrl,
  newProxySubscriptionId,
  PROXY_SUBSCRIPTIONS_MAX,
  type ProxySubscription
} from '@shared/types/proxy-subscription'
import { Button, Empty, Input, Segmented, StatusDot, Switch, type Tone } from '../components/ui'
import { PageHeader, PanelHeader } from '../components/layout'
import { NumberField, SettingsRow } from '../components/settings-fields'
import { ProxySubscriptionDialog } from '../components/proxy-subscription-dialog'
import { useToast } from '../components/use-toast'
import { timeAgo } from '../lib/format-time'

function proxyStateTone(state: ProxyCoreState): Tone {
  if (state === 'running') return 'ok'
  if (state === 'error') return 'fail'
  if (state === 'starting') return 'warn'
  return 'default'
}

function proxyStateLabel(state: ProxyCoreState): string {
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

export function SettingsPage(): React.JSX.Element {
  const [settings, setSettings] = useState<AppSettings | null>(null)
  const [diag, setDiag] = useState<Record<string, unknown> | null>(null)
  const [blocked, setBlocked] = useState<BlockedTarget[]>([])
  const [proxyStatus, setProxyStatus] = useState<ProxyCoreStatus | null>(null)
  const [proxyBusy, setProxyBusy] = useState(false)
  const [detailOpen, setDetailOpen] = useState(false)
  /** 新增订阅草稿：仅本地表单，点保存才写入 */
  const [subDraft, setSubDraft] = useState<{
    name: string
    url: string
    enabled: boolean
  } | null>(null)
  const toast = useToast()

  const reloadBlocklist = useCallback(async (): Promise<void> => {
    setBlocked(await window.api.blocklist.list())
  }, [])

  const reloadProxy = useCallback(async (): Promise<void> => {
    setProxyStatus(await window.api.proxyCore.status())
  }, [])

  useEffect(() => {
    void window.api.settings.get().then(setSettings)
    void window.api.diagnostics.get().then(setDiag)
    void reloadBlocklist()
    void reloadProxy()
  }, [reloadBlocklist, reloadProxy])

  useEffect(() => {
    if (!proxyStatus || (proxyStatus.state !== 'starting' && proxyStatus.state !== 'running')) return
    const t = window.setInterval(() => void reloadProxy(), 2000)
    return () => window.clearInterval(t)
  }, [proxyStatus?.state, reloadProxy])

  if (!settings) return <div className="muted">加载设置…</div>
  const s = settings

  async function save(partial: Partial<AppSettings>): Promise<void> {
    const next = await window.api.settings.set(partial)
    setSettings(next)
    toast('已保存', 'ok')
    setDiag(await window.api.diagnostics.get())
    if (
      partial.proxyCoreEnabled !== undefined ||
      partial.proxySubscriptionUrl !== undefined ||
      partial.proxySubscriptions !== undefined ||
      partial.proxyCallLogEnabled !== undefined
    ) {
      await reloadProxy()
    }
  }

  async function saveSubs(subs: ProxySubscription[], toastMsg = '已保存'): Promise<void> {
    const next = await window.api.settings.set({ proxySubscriptions: subs })
    setSettings(next)
    toast(toastMsg, 'ok')
    await reloadProxy()
  }

  async function applyProxy(enabled: boolean): Promise<void> {
    setProxyBusy(true)
    try {
      const status = await window.api.proxyCore.apply({
        enabled,
        subscriptions: s.proxySubscriptions,
        callLogEnabled: s.proxyCallLogEnabled
      })
      setProxyStatus(status)
      setSettings(await window.api.settings.get())
      if (status.state === 'running') {
        toast('代理内核已启动', 'ok')
        if (status.tunLikely) {
          toast('检测到 TUN，可能与内置代理冲突', 'warn')
        }
      } else if (status.state === 'error') toast(status.message, 'fail')
      else if (!enabled) toast('代理内核已关闭', 'ok')
      setDiag(await window.api.diagnostics.get())
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), 'fail')
    } finally {
      setProxyBusy(false)
    }
  }

  function updateSub(id: string, patch: Partial<ProxySubscription>): void {
    if (typeof patch.url === 'string') {
      const url = patch.url.trim()
      if (!url || !isAllowedProxySubscriptionUrl(url)) {
        toast('订阅 URL 仅支持 http(s)://', 'warn')
        void window.api.settings.get().then(setSettings)
        return
      }
      patch = { ...patch, url }
    }
    const next = s.proxySubscriptions.map((row) =>
      row.id === id ? { ...row, ...patch } : row
    )
    void saveSubs(next)
  }

  function removeSub(id: string): void {
    void saveSubs(
      s.proxySubscriptions.filter((row) => row.id !== id),
      '已删除订阅'
    )
  }

  function startAddSub(): void {
    if (subDraft) return
    if (s.proxySubscriptions.length >= PROXY_SUBSCRIPTIONS_MAX) {
      toast(`最多 ${PROXY_SUBSCRIPTIONS_MAX} 个订阅`, 'warn')
      return
    }
    setSubDraft({
      name: `订阅 ${s.proxySubscriptions.length + 1}`,
      url: '',
      enabled: true
    })
  }

  function cancelAddSub(): void {
    setSubDraft(null)
  }

  async function commitAddSub(): Promise<void> {
    if (!subDraft) return
    const url = subDraft.url.trim()
    if (!url) {
      toast('请填写订阅 URL', 'warn')
      return
    }
    if (!isAllowedProxySubscriptionUrl(url)) {
      toast('订阅 URL 仅支持 http(s)://', 'warn')
      return
    }
    if (s.proxySubscriptions.length >= PROXY_SUBSCRIPTIONS_MAX) {
      toast(`最多 ${PROXY_SUBSCRIPTIONS_MAX} 个订阅`, 'warn')
      return
    }
    const name = subDraft.name.trim() || `订阅 ${s.proxySubscriptions.length + 1}`
    await saveSubs(
      [
        ...s.proxySubscriptions,
        {
          id: newProxySubscriptionId(),
          name,
          url,
          enabled: subDraft.enabled
        }
      ],
      '已保存订阅'
    )
    setSubDraft(null)
  }

  async function unblock(b: BlockedTarget): Promise<void> {
    await window.api.blocklist.remove({ targetType: b.targetType, targetId: b.targetId })
    toast('已解除屏蔽', 'ok')
    await reloadBlocklist()
  }

  async function clearBlocklist(): Promise<void> {
    const { deleted } = await window.api.blocklist.clear()
    toast(deleted ? `已清空 ${deleted} 条` : '名单为空', 'ok')
    await reloadBlocklist()
  }

  return (
    <div className="stack">
      <PageHeader title="设置" meta="外观、同步节奏与诊断" />

      <div className="settings">
        <div className="panel">
          <PanelHeader title="外观" />
          <SettingsRow label="主题" desc="默认跟随系统；可强制浅色或深色">
            <Segmented<ThemeMode>
              label="主题"
              value={settings.theme}
              onChange={(v) => void save({ theme: v })}
              options={[
                { value: 'system', label: '跟随系统' },
                { value: 'light', label: '浅色' },
                { value: 'dark', label: '深色' }
              ]}
            />
          </SettingsRow>
        </div>

        <div className="panel">
          <PanelHeader title="同步" />
          <SettingsRow label="暂停所有网络同步" desc="打开后所有同步入口置灰；本地搜索与浏览不受影响">
            <Switch
              label="暂停所有网络同步"
              checked={settings.networkPaused}
              onChange={(v) => void save({ networkPaused: v })}
            />
          </SettingsRow>
          <SettingsRow label="允许店铺深刮" desc="价格来源；关闭后不再访问发卡网，已同步数据保留">
            <Switch
              label="允许店铺深刮"
              checked={settings.shopScrapeEnabled ?? settings.ldxpScrapeEnabled}
              onChange={(v) => void save({ shopScrapeEnabled: v })}
            />
          </SettingsRow>
          <SettingsRow label="PriceAI 请求间隔" desc="商家列表分页抓取的间隔">
            <NumberField
              value={settings.requestIntervalMs}
              min={100}
              onCommit={(v) => void save({ requestIntervalMs: v })}
            />
            <span className="unit">ms</span>
          </SettingsRow>
          <SettingsRow label="店铺最小间隔" desc="串行深刮相邻两店之间的最小间隔">
            <NumberField
              value={settings.shopMinIntervalMs ?? settings.ldxpMinIntervalMs}
              min={100}
              onCommit={(v) => void save({ shopMinIntervalMs: v })}
            />
            <span className="unit">ms</span>
          </SettingsRow>
          <SettingsRow
            label="分页并发"
            desc={`单店商品列表最多同时在途的页数；限流按代理节点分别计（每节点仍遵守店铺最小间隔）。无内置代理时退回全局间隔（${SHOP_API_LIMITS.pageConcurrency.min}–${SHOP_API_LIMITS.pageConcurrency.max}）`}
          >
            <NumberField
              value={settings.shopPageConcurrency}
              min={SHOP_API_LIMITS.pageConcurrency.min}
              max={SHOP_API_LIMITS.pageConcurrency.max}
              onCommit={(v) => void save({ shopPageConcurrency: v })}
            />
            <span className="unit">页</span>
          </SettingsRow>
          <SettingsRow
            label="旧数据阈值"
            desc="超过此时长未成功同步的店视为旧数据；「同步旧数据店铺」与自动刷新只处理这些店；搜索结果会标注过期"
          >
            <NumberField
              value={settings.shopFreshHours}
              min={1}
              max={24 * 30}
              onCommit={(v) => void save({ shopFreshHours: v })}
            />
            <span className="unit">小时</span>
          </SettingsRow>
          <SettingsRow
            label="自动刷新旧数据店铺"
            desc="默认关闭；开启后应用运行期间按平台随机挑选旧数据店铺，每次只同步一家"
          >
            <Switch
              label="自动刷新旧数据店铺"
              checked={settings.autoRefreshEnabled}
              onChange={(v) => void save({ autoRefreshEnabled: v })}
            />
          </SettingsRow>
          <SettingsRow label="自动刷新最短间隔" desc="每个平台两次自动刷新之间的最短等待时间">
            <NumberField
              value={Math.round(settings.autoRefreshMinIntervalMs / 60_000)}
              min={AUTO_REFRESH_LIMITS.minIntervalMs.min / 60_000}
              max={AUTO_REFRESH_LIMITS.minIntervalMs.max / 60_000}
              disabled={!settings.autoRefreshEnabled}
              onCommit={(v) => void save({ autoRefreshMinIntervalMs: v * 60_000 })}
            />
            <span className="unit">分钟</span>
          </SettingsRow>
          <SettingsRow label="自动刷新最长间隔" desc="实际等待时间会在最短与最长间隔之间随机选择">
            <NumberField
              value={Math.round(settings.autoRefreshMaxIntervalMs / 60_000)}
              min={AUTO_REFRESH_LIMITS.maxIntervalMs.min / 60_000}
              max={AUTO_REFRESH_LIMITS.maxIntervalMs.max / 60_000}
              disabled={!settings.autoRefreshEnabled}
              onCommit={(v) => void save({ autoRefreshMaxIntervalMs: v * 60_000 })}
            />
            <span className="unit">分钟</span>
          </SettingsRow>
          <SettingsRow label="同步完成通知" desc="任务结束时发送系统通知（需系统允许通知权限）">
            <Switch
              label="同步完成通知"
              checked={settings.notifyOnJobFinished}
              onChange={(v) => void save({ notifyOnJobFinished: v })}
            />
          </SettingsRow>
          <SettingsRow
            label="同步失败直接屏蔽"
            desc="店铺深刮失败时自动把该商家加入屏蔽名单（含网络错误；用户取消除外）。可在下方名单解除"
          >
            <Switch
              label="同步失败直接屏蔽"
              checked={settings.blockOnShopSyncFail}
              onChange={(v) => void save({ blockOnShopSyncFail: v })}
            />
          </SettingsRow>
        </div>

        <div className="panel">
          <PanelHeader
            title="内置代理"
            sub="mihomo 内核 · 每订阅一组 load-balance · 仅本机 mixed-port"
          />
          <SettingsRow
            label="启用内置代理"
            desc="开启后同步流量走本地内核；首次会下载 mihomo 到用户目录"
          >
            <Switch
              label="启用内置代理"
              checked={s.proxyCoreEnabled}
              disabled={proxyBusy}
              onChange={(v) => void applyProxy(v)}
            />
          </SettingsRow>
          <SettingsRow
            label="订阅列表"
            desc={`每个 URL 为一组（最多 ${PROXY_SUBSCRIPTIONS_MAX}）；仅存本机`}
          >
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <Button
                type="button"
                size="s"
                variant="ghost"
                disabled={proxyBusy || subDraft != null}
                onClick={startAddSub}
              >
                添加订阅
              </Button>
              <Button
                type="button"
                size="s"
                variant="ghost"
                onClick={() => setDetailOpen(true)}
              >
                订阅详情
              </Button>
            </div>
          </SettingsRow>
          {s.proxySubscriptions.length === 0 && !subDraft ? (
            <p className="proxy-sub-empty">尚未添加订阅。点击「添加订阅」填写后保存。</p>
          ) : null}
          <div className="proxy-sub-list">
            {s.proxySubscriptions.map((row) => (
              <div key={row.id} className="proxy-sub-card">
                <div className="proxy-sub-card-row">
                  <Input
                    className="proxy-sub-name"
                    value={row.name}
                    disabled={proxyBusy}
                    placeholder="名称"
                    onChange={(e) => {
                      const name = e.target.value
                      setSettings({
                        ...s,
                        proxySubscriptions: s.proxySubscriptions.map((x) =>
                          x.id === row.id ? { ...x, name } : x
                        )
                      })
                    }}
                    onBlur={(e) => {
                      const name = e.target.value.trim() || row.name
                      if (name !== row.name) updateSub(row.id, { name })
                    }}
                  />
                  <Input
                    className="proxy-sub-card-url"
                    type="url"
                    placeholder="https://… 订阅链接"
                    value={row.url}
                    disabled={proxyBusy}
                    onChange={(e) => {
                      const url = e.target.value
                      setSettings({
                        ...s,
                        proxySubscriptions: s.proxySubscriptions.map((x) =>
                          x.id === row.id ? { ...x, url } : x
                        )
                      })
                    }}
                    onBlur={(e) => {
                      const url = e.target.value.trim()
                      if (url !== row.url) updateSub(row.id, { url })
                    }}
                  />
                  <div className="proxy-sub-card-actions">
                    <label className="proxy-sub-enable">
                      <span>启用</span>
                      <Switch
                        label="启用"
                        checked={row.enabled}
                        disabled={proxyBusy}
                        onChange={(v) => updateSub(row.id, { enabled: v })}
                      />
                    </label>
                    <Button
                      type="button"
                      size="s"
                      variant="danger"
                      disabled={proxyBusy}
                      onClick={() => removeSub(row.id)}
                    >
                      删除
                    </Button>
                  </div>
                </div>
              </div>
            ))}
            {subDraft ? (
              <div className="proxy-sub-card is-draft">
                <p className="proxy-sub-card-hint">新订阅（未保存）</p>
                <div className="proxy-sub-card-row">
                  <Input
                    className="proxy-sub-name"
                    value={subDraft.name}
                    disabled={proxyBusy}
                    placeholder="名称"
                    onChange={(e) => setSubDraft({ ...subDraft, name: e.target.value })}
                  />
                  <Input
                    className="proxy-sub-card-url"
                    type="url"
                    placeholder="https://… 订阅链接"
                    value={subDraft.url}
                    disabled={proxyBusy}
                    autoFocus
                    onChange={(e) => setSubDraft({ ...subDraft, url: e.target.value })}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault()
                        void commitAddSub()
                      }
                    }}
                  />
                  <div className="proxy-sub-card-actions">
                    <label className="proxy-sub-enable">
                      <span>启用</span>
                      <Switch
                        label="启用"
                        checked={subDraft.enabled}
                        disabled={proxyBusy}
                        onChange={(v) => setSubDraft({ ...subDraft, enabled: v })}
                      />
                    </label>
                    <Button
                      type="button"
                      size="s"
                      variant="primary"
                      disabled={proxyBusy}
                      onClick={() => void commitAddSub()}
                    >
                      保存
                    </Button>
                    <Button
                      type="button"
                      size="s"
                      variant="ghost"
                      disabled={proxyBusy}
                      onClick={cancelAddSub}
                    >
                      取消
                    </Button>
                  </div>
                </div>
              </div>
            ) : null}
          </div>
          <div className="proxy-status-bar">
            <div className="proxy-status-main">
              {proxyStatus ? (
                <>
                  <div className="proxy-status-line">
                    <StatusDot tone={proxyStateTone(proxyStatus.state)}>
                      {proxyStateLabel(proxyStatus.state)}
                    </StatusDot>
                    {proxyStatus.proxyUrl ? (
                      <span className="proxy-status-chip mono" title="本地出口">
                        {proxyStatus.proxyUrl.replace(/^https?:\/\//, '')}
                      </span>
                    ) : null}
                    {proxyStatus.groupCount > 0 ? (
                      <span className="proxy-status-chip">{proxyStatus.groupCount} 组</span>
                    ) : null}
                  </div>
                  {proxyStatus.message ? (
                    <p className="proxy-status-msg">{proxyStatus.message}</p>
                  ) : null}
                </>
              ) : (
                <span className="small muted">加载状态…</span>
              )}
              {proxyStatus?.tunLikely ? (
                <p className="proxy-status-tun">
                  检测到 TUN
                  {proxyStatus.tunInterfaces?.length
                    ? `（${proxyStatus.tunInterfaces.join(', ')}）`
                    : ''}
                  ，可能与内置代理冲突。建议关闭 TUN，或将本应用加入绕过。
                </p>
              ) : null}
            </div>
            <Button
              size="s"
              variant="primary"
              disabled={proxyBusy}
              onClick={() => void applyProxy(true)}
            >
              {proxyBusy ? '处理中…' : '应用'}
            </Button>
          </div>
        </div>

        {detailOpen ? (
          <ProxySubscriptionDialog
            onClose={() => setDetailOpen(false)}
            onCallLogChange={(enabled) => {
              setSettings((prev) => (prev ? { ...prev, proxyCallLogEnabled: enabled } : prev))
            }}
          />
        ) : null}

        <div className="panel">
          <PanelHeader
            title="屏蔽名单"
            sub={
              <>
                {blocked.length ? `${blocked.length} 条 · ` : ''}
                搜索默认排除；收藏仍保留
              </>
            }
            actions={
              blocked.length ? (
                <Button variant="danger" size="s" onClick={() => void clearBlocklist()}>
                  清空
                </Button>
              ) : null
            }
          />
          {blocked.length === 0 ? (
            <Empty title="暂无屏蔽">在商家详情点「屏蔽商家」。</Empty>
          ) : (
            <table className="table">
              <thead>
                <tr>
                  <th>名称</th>
                  <th>类型</th>
                  <th>时间</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {blocked.map((b) => (
                  <tr key={`${b.targetType}:${b.targetId}`}>
                    <td>
                      <div className="ellipsis" style={{ maxWidth: 320 }}>
                        {b.titleSnapshot || b.targetId}
                      </div>
                    </td>
                    <td className="small muted">{b.targetType === 'merchant' ? '商家' : '商品'}</td>
                    <td className="small muted" title={b.createdAt}>
                      {timeAgo(b.createdAt)}
                    </td>
                    <td>
                      <button className="linkish" type="button" onClick={() => void unblock(b)}>
                        解除
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        <div className="panel diag">
          <details>
            <summary>诊断</summary>
            <pre>{diag ? JSON.stringify(diag, null, 2) : '加载中…'}</pre>
          </details>
        </div>
      </div>
    </div>
  )
}
