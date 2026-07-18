import { useCallback, useEffect, useState } from 'react'
import type { BlockedTarget } from '@shared/types/blocklist'
import { SHOP_API_LIMITS } from '@shared/constants'
import type { AppSettings, ThemeMode } from '@shared/types/settings'
import { Button, Empty, Switch } from '../components/ui'
import { PageHeader, PanelHeader } from '../components/layout'
import { NumberField, SettingsRow } from '../components/settings-fields'
import { Select } from '../components/select'
import { useToast } from '../components/use-toast'
import { timeAgo } from '../lib/format-time'

export function SettingsPage(): React.JSX.Element {
  const [settings, setSettings] = useState<AppSettings | null>(null)
  const [diag, setDiag] = useState<Record<string, unknown> | null>(null)
  const [blocked, setBlocked] = useState<BlockedTarget[]>([])
  const toast = useToast()

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

  return (
    <div className="stack">
      <PageHeader title="设置" meta="外观、同步节奏与诊断" />

      <div className="settings">
        <div className="panel">
          <PanelHeader title="外观" />
          <SettingsRow label="主题" desc="默认跟随系统；可强制浅色或深色">
            <Select<ThemeMode>
              ariaLabel="主题"
              value={settings.theme}
              onValueChange={(v) => void save({ theme: v })}
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
            desc={`单店商品列表一次并行请求的页数（${SHOP_API_LIMITS.pageConcurrency.min}–${SHOP_API_LIMITS.pageConcurrency.max}，过大易触发风控）`}
          >
            <NumberField
              value={settings.shopPageConcurrency}
              min={SHOP_API_LIMITS.pageConcurrency.min}
              max={SHOP_API_LIMITS.pageConcurrency.max}
              onCommit={(v) => void save({ shopPageConcurrency: v })}
            />
            <span className="unit">页</span>
          </SettingsRow>
          <SettingsRow label="价格新鲜期" desc="增量同步跳过期限内成功的店；超龄价格在结果中标注">
            <NumberField
              value={settings.shopFreshHours}
              min={1}
              onCommit={(v) => void save({ shopFreshHours: v })}
            />
            <span className="unit">小时</span>
          </SettingsRow>
          <SettingsRow label="同步完成通知" desc="任务结束时发送系统通知（需系统允许通知权限）">
            <Switch
              label="同步完成通知"
              checked={settings.notifyOnJobFinished}
              onChange={(v) => void save({ notifyOnJobFinished: v })}
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
                <Button variant="ghost" size="s" onClick={() => void clearBlocklist()}>
                  清空
                </Button>
              ) : null
            }
          />
          {blocked.length === 0 ? (
            <Empty title="暂无屏蔽">在搜索结果点「屏蔽 / 屏蔽店」，或在商家详情点「屏蔽」。</Empty>
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
