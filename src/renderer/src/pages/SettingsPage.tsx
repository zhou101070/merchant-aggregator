import { useCallback, useEffect, useState } from 'react'
import type { BlockedTarget } from '@shared/types/blocklist'
import type { AppSettings } from '@shared/types/settings'
import { Button, Empty, Input, Switch } from '../components/ui'
import { Select } from '../components/select'
import { useToast } from '../components/use-toast'
import { timeAgo } from '../lib/format-time'

/** 单行设置项：左侧 label + 说明，右侧控件 */
function Row({
  label,
  desc,
  children
}: {
  label: string
  desc?: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <div className="settings-row">
      <div className="s-main">
        <div className="s-label">{label}</div>
        {desc ? <div className="s-desc">{desc}</div> : null}
      </div>
      <div className="s-ctrl">{children}</div>
    </div>
  )
}

/** 数字输入：失焦提交，非法值回退(key 随 value 变化重挂载，无需状态同步) */
function NumberField({
  value,
  min,
  onCommit
}: {
  value: number
  min: number
  onCommit: (v: number) => void
}): React.JSX.Element {
  return (
    <Input
      key={value}
      type="number"
      min={min}
      defaultValue={value}
      onBlur={(e) => {
        const v = Number(e.target.value)
        if (Number.isFinite(v) && v >= min && v !== value) onCommit(v)
        else e.target.value = String(value)
      }}
    />
  )
}

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
      <div className="page-head">
        <div>
          <h1 className="page-title">设置</h1>
          <div className="page-meta">同步节奏、外链策略与诊断</div>
        </div>
      </div>

      <div className="settings">
        <div className="panel">
          <div className="panel-head">
            <strong>同步</strong>
          </div>
          <Row label="暂停所有网络同步" desc="打开后所有同步入口置灰；本地搜索与浏览不受影响">
            <Switch
              label="暂停所有网络同步"
              checked={settings.networkPaused}
              onChange={(v) => void save({ networkPaused: v })}
            />
          </Row>
          <Row label="允许店铺深刮" desc="价格来源；关闭后不再访问发卡网，已同步数据保留">
            <Switch
              label="允许店铺深刮"
              checked={settings.shopScrapeEnabled ?? settings.ldxpScrapeEnabled}
              onChange={(v) => void save({ shopScrapeEnabled: v })}
            />
          </Row>
          <Row label="PriceAI 请求间隔" desc="商家列表分页抓取的间隔">
            <NumberField
              value={settings.requestIntervalMs}
              min={100}
              onCommit={(v) => void save({ requestIntervalMs: v })}
            />
            <span className="unit">ms</span>
          </Row>
          <Row label="店铺最小间隔" desc="串行深刮相邻两店之间的最小间隔">
            <NumberField
              value={settings.shopMinIntervalMs ?? settings.ldxpMinIntervalMs}
              min={100}
              onCommit={(v) => void save({ shopMinIntervalMs: v })}
            />
            <span className="unit">ms</span>
          </Row>
          <Row label="价格新鲜期" desc="增量同步跳过期限内成功的店；超龄价格在结果中标注">
            <NumberField
              value={settings.shopFreshHours}
              min={1}
              onCommit={(v) => void save({ shopFreshHours: v })}
            />
            <span className="unit">小时</span>
          </Row>
          <Row label="同步完成通知" desc="任务结束时发送系统通知（需系统允许通知权限）">
            <Switch
              label="同步完成通知"
              checked={settings.notifyOnJobFinished}
              onChange={(v) => void save({ notifyOnJobFinished: v })}
            />
          </Row>
        </div>

        <div className="panel">
          <div className="panel-head">
            <strong>外链</strong>
          </div>
          <Row label="打开源站方式" desc="所有外链仅限 https；直开绝不附带任何本地数据">
            <Select
              ariaLabel="打开源站方式"
              value={settings.openExternalMode}
              onValueChange={(v) => void save({ openExternalMode: v })}
              options={[
                { value: 'allowlist_confirm', label: '白名单直开 / 其他确认' },
                { value: 'allowlist_reject', label: '仅白名单' },
                { value: 'https_only', label: '任意 https（不推荐）' }
              ]}
            />
          </Row>
        </div>

        <div className="panel">
          <div className="panel-head">
            <strong>屏蔽名单</strong>
            <span className="sub">
              {blocked.length ? `${blocked.length} 条 · ` : ''}
              搜索与比价默认排除；收藏仍保留
            </span>
            {blocked.length ? (
              <Button variant="ghost" size="s" onClick={() => void clearBlocklist()}>
                清空
              </Button>
            ) : null}
          </div>
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
