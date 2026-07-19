import { useCallback, useEffect, useState } from 'react'
import type { BlockedTarget } from '@shared/types/blocklist'
import { AUTO_REFRESH_LIMITS } from '@shared/constants'
import type { AppSettings, ThemeMode } from '@shared/types/settings'
import { Button, Empty, Segmented, Switch } from '../components/ui'
import { PageHeader, PanelHeader } from '../components/layout'
import { NumberField, SettingsRow } from '../components/settings-fields'
import { useConfirm } from '../components/use-confirm'
import { useToast } from '../components/use-toast'
import { emitDataCleared } from '../lib/data-events'
import { timeAgo } from '../lib/format-time'
import { formatUserError } from '../lib/sync-labels'

export function SettingsPage(): React.JSX.Element {
  const [settings, setSettings] = useState<AppSettings | null>(null)
  const [diag, setDiag] = useState<Record<string, unknown> | null>(null)
  const [blocked, setBlocked] = useState<BlockedTarget[]>([])
  const toast = useToast()
  const confirm = useConfirm()
  const [clearBusy, setClearBusy] = useState(false)

  const reloadBlocklist = useCallback(async (): Promise<void> => {
    setBlocked(await window.api.blocklist.list())
  }, [])

  useEffect(() => {
    void window.api.settings.get().then(setSettings)
    void window.api.diagnostics.get().then(setDiag)
    void reloadBlocklist()
  }, [reloadBlocklist])

  if (!settings) return <div className="muted">加载设置…</div>

  async function save(partial: Partial<AppSettings>): Promise<void> {
    const next = await window.api.settings.set(partial)
    setSettings(next)
    toast('已保存', 'ok')
    setDiag(await window.api.diagnostics.get())
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

  async function clearAllData(): Promise<void> {
    if (clearBusy) return
    if (
      !(await confirm({
        title: '清空全部业务数据',
        body: '将删除商家、商品、收藏、最近浏览、屏蔽名单与同步任务历史。设置会保留。此操作不可撤销。',
        confirmLabel: '确认清空',
        danger: true
      }))
    ) {
      return
    }
    setClearBusy(true)
    try {
      const res = await window.api.data.clearAll()
      emitDataCleared()
      await reloadBlocklist()
      setDiag(await window.api.diagnostics.get())
      toast(res.total ? `已清空 ${res.total} 条记录` : '没有可清空的数据', 'ok')
    } catch (err) {
      toast(formatUserError(err), 'fail')
    } finally {
      setClearBusy(false)
    }
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
          <SettingsRow label="店铺最小间隔" desc="深刮/刷新库存时，同一店内相邻两次 API 请求的最小间隔">
            <NumberField
              value={settings.shopMinIntervalMs ?? settings.ldxpMinIntervalMs}
              min={100}
              onCommit={(v) => void save({ shopMinIntervalMs: v })}
            />
            <span className="unit">ms</span>
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

        <div className="panel">
          <PanelHeader title="数据" />
          <SettingsRow
            label="清空业务数据"
            desc="删除商家、商品、收藏、最近浏览、屏蔽名单与同步历史；设置保留。同步进行中时不可清空。"
          >
            <Button
              variant="danger"
              size="s"
              disabled={clearBusy}
              onClick={() => void clearAllData()}
            >
              {clearBusy ? '清空中…' : '一键清空'}
            </Button>
          </SettingsRow>
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
