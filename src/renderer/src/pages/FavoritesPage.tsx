import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import type { Favorite, RecentView } from '@shared/types/favorites'
import type { SearchHit } from '@shared/types/search'
import { CompareDrawer } from '../components/compare-drawer'
import { CopyLinkButton } from '../components/copy-link-button'
import { Badge, Button, Empty, IconButton, Input, Price } from '../components/ui'
import { Icon } from '../components/icons'
import { useToast } from '../components/use-toast'
import { useSyncStatus } from '../hooks/useSync'
import { openExternalSafe } from '../lib/open-external'
import { timeAgo } from '../lib/format-time'
import { resolveShopRef } from '../lib/shop-ref'
import { itemUrlFromProductId } from '../lib/shop-url'

function typeLabel(t: string): string {
  if (t === 'merchant') return '商家'
  if (t === 'shop_product') return '商品'
  return t
}

/** Prefer DB source_url; else registry item URL from product id. */
function favoriteOpenUrl(f: Favorite): string | null {
  if (f.sourceUrl) return f.sourceUrl
  if (f.targetType === 'shop_product') {
    return itemUrlFromProductId(f.targetId)
  }
  return null
}

function recentItemUrl(r: RecentView): string | null {
  if (r.targetType !== 'shop_product') return null
  return itemUrlFromProductId(r.targetId)
}

type ShopRefKey = string

/** D20 / §8: unique (platformId, shopToken) for refresh; merchantId optional. */
function collectRefreshTargets(favorites: Favorite[]): {
  platformId: string
  token: string
  merchantId?: string
}[] {
  const map = new Map<ShopRefKey, { platformId: string; token: string; merchantId?: string }>()
  for (const f of favorites) {
    const ref = resolveShopRef({
      platformId: f.platformId,
      shopToken: f.shopToken,
      ldxpToken: f.ldxpToken,
      strictPlatform: true
    })
    if (!ref) continue
    const key = `${ref.platformId}\0${ref.token}`
    const prev = map.get(key)
    if (!prev) {
      map.set(key, {
        platformId: ref.platformId,
        token: ref.token,
        merchantId: f.merchantId ?? undefined
      })
    } else if (!prev.merchantId && f.merchantId) {
      prev.merchantId = f.merchantId
    }
  }
  return [...map.values()]
}

function priceDelta(
  current: number | null | undefined,
  baseline: number | null | undefined
): number | null {
  if (current == null || baseline == null) return null
  if (!Number.isFinite(current) || !Number.isFinite(baseline)) return null
  return current - baseline
}

function formatDelta(delta: number): string {
  const abs = Math.abs(delta)
  const body = abs >= 10 ? abs.toFixed(0) : abs.toFixed(2).replace(/\.?0+$/, '')
  if (delta < 0) return `↓${body}`
  if (delta > 0) return `↑${body}`
  return '持平'
}

export function FavoritesPage(): React.JSX.Element {
  const navigate = useNavigate()
  const toast = useToast()
  const { start, busy, progress, status } = useSyncStatus()
  const [favorites, setFavorites] = useState<Favorite[]>([])
  const [recent, setRecent] = useState<RecentView[]>([])
  const [refreshing, setRefreshing] = useState(false)
  const [editingKey, setEditingKey] = useState<string | null>(null)
  const [noteDraft, setNoteDraft] = useState('')
  const [targetDraft, setTargetDraft] = useState('')
  const [compareTitle, setCompareTitle] = useState<string | null>(null)

  const openCompareHit = useCallback(async (hit: SearchHit): Promise<void> => {
    await window.api.recent.touch({
      targetType: hit.kind,
      targetId: hit.id,
      titleSnapshot: hit.title
    })
    await openExternalSafe(hit.sourceUrl)
  }, [])

  const reload = useCallback(async (): Promise<void> => {
    setFavorites(await window.api.favorites.list())
    setRecent(await window.api.recent.list(40))
  }, [])

  const syncTick =
    progress && ['succeeded', 'failed', 'partial', 'cancelled'].includes(progress.status)
      ? `${progress.jobId}:${progress.status}`
      : ''
  useEffect(() => {
    void reload()
  }, [reload, syncTick, status?.counts.shopProducts])

  const refreshTargets = useMemo(() => collectRefreshTargets(favorites), [favorites])

  async function waitForSyncIdle(maxMs = 150_000): Promise<boolean> {
    const t0 = Date.now()
    while (Date.now() - t0 < maxMs) {
      const s = await window.api.sync.status()
      if (!s.running.length) return true
      await new Promise((r) => setTimeout(r, 250))
    }
    return false
  }

  async function waitForJobDone(jobId: string, maxMs = 150_000): Promise<void> {
    const t0 = Date.now()
    while (Date.now() - t0 < maxMs) {
      const s = await window.api.sync.status()
      if (s.running.some((j) => j.id === jobId)) {
        await new Promise((r) => setTimeout(r, 250))
        continue
      }
      const done = s.recent.find((j) => j.id === jobId)
      if (done && done.status !== 'running' && done.status !== 'pending') return
      // Job left running map; treat as settled even if not yet in recent.
      return
    }
    throw new Error('等待同步任务超时')
  }

  async function refreshFavoriteShops(): Promise<void> {
    if (!refreshTargets.length || busy || refreshing) return
    setRefreshing(true)
    toast(`将刷新 ${refreshTargets.length} 家收藏相关店铺`)
    const failures: string[] = []
    try {
      for (const t of refreshTargets) {
        const label = `${t.platformId}/${t.token}`
        try {
          const idle = await waitForSyncIdle()
          if (!idle) {
            failures.push(`${label}: 等待通道空闲超时`)
            continue
          }
          const { jobId } = await window.api.sync.start({
            jobType: 'shop_one',
            platformId: t.platformId,
            token: t.token,
            merchantId: t.merchantId
          })
          await waitForJobDone(jobId)
        } catch (err) {
          failures.push(`${label}: ${err instanceof Error ? err.message : String(err)}`)
        }
      }
      if (failures.length) {
        toast(
          `有 ${failures.length}/${refreshTargets.length} 家店铺刷新失败：${failures[0]}`,
          'fail'
        )
      }
    } finally {
      await waitForSyncIdle(30_000)
      setRefreshing(false)
      void reload()
    }
  }

  function openRecent(r: RecentView): void {
    if (r.targetType === 'merchant') {
      navigate(`/merchants?id=${encodeURIComponent(r.targetId)}`)
      return
    }
    const q = r.titleSnapshot?.trim()
    navigate(q ? `/?q=${encodeURIComponent(q)}` : '/')
  }

  function favKey(f: Favorite): string {
    return `${f.targetType}:${f.targetId}`
  }

  function beginEdit(f: Favorite): void {
    setEditingKey(favKey(f))
    setNoteDraft(f.note ?? '')
    setTargetDraft(f.targetPrice != null ? String(f.targetPrice) : '')
  }

  async function saveEdit(f: Favorite): Promise<void> {
    const note = noteDraft.trim() || null
    const raw = targetDraft.trim()
    let targetPrice: number | null = null
    if (raw) {
      const n = Number(raw)
      if (!Number.isFinite(n) || n < 0) {
        toast('目标价无效', 'fail')
        return
      }
      targetPrice = n
    }
    const updated = await window.api.favorites.update({
      targetType: f.targetType,
      targetId: f.targetId,
      note,
      targetPrice
    })
    if (!updated) {
      toast('保存失败', 'fail')
      return
    }
    toast('已保存', 'ok')
    setEditingKey(null)
    await reload()
  }

  return (
    <div className="stack">
      <div className="page-head">
        <div>
          <h1 className="page-title">收藏与最近</h1>
          <div className="page-meta">当前价 vs 收藏基线；可设目标价与备注；刷新店后看涨跌</div>
        </div>
        <div className="page-actions">
          <Button
            disabled={busy || refreshing || !refreshTargets.length}
            onClick={() => void refreshFavoriteShops()}
            title="按平台+token 重新抓取收藏涉及的店铺（含无商家主档的 orphan）"
          >
            <Icon name="refresh" size={14} />
            刷新收藏的店{refreshTargets.length ? `(${refreshTargets.length})` : ''}
          </Button>
          <Button variant="ghost" onClick={() => void reload()}>
            刷新列表
          </Button>
        </div>
      </div>

      <div className="panel">
        <div className="panel-head">
          <strong>最近浏览</strong>
          <span className="sub">
            {recent.length ? `${recent.length} 条 · ` : ''}
            商家直达详情；商品可开源站或按标题重搜
          </span>
        </div>
        {recent.length === 0 ? (
          <Empty title="暂无最近浏览">打开源站或查看商家详情后，会出现在这里。</Empty>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>标题</th>
                <th>类型</th>
                <th>时间</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {recent.map((r) => {
                const itemUrl = recentItemUrl(r)
                return (
                  <tr
                    key={`${r.targetType}:${r.targetId}:${r.viewedAt}`}
                    style={{ cursor: 'pointer' }}
                    onClick={() => openRecent(r)}
                  >
                    <td>
                      <div className="ellipsis" style={{ maxWidth: 420 }}>
                        {r.titleSnapshot ?? r.targetId}
                      </div>
                    </td>
                    <td className="small muted">{typeLabel(r.targetType)}</td>
                    <td className="small muted" title={r.viewedAt}>
                      {timeAgo(r.viewedAt)}
                    </td>
                    <td onClick={(e) => e.stopPropagation()}>
                      <div className="row-actions">
                        {itemUrl ? (
                          <>
                            <IconButton
                              label="打开源站"
                              onClick={() => void openExternalSafe(itemUrl)}
                            >
                              <Icon name="external" size={14} />
                            </IconButton>
                            <CopyLinkButton url={itemUrl} />
                          </>
                        ) : null}
                        {r.targetType === 'shop_product' && r.titleSnapshot ? (
                          <button
                            className="linkish"
                            type="button"
                            onClick={() => setCompareTitle(r.titleSnapshot)}
                          >
                            比价
                          </button>
                        ) : null}
                      </div>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
      </div>

      <div className="panel">
        <div className="panel-head">
          <strong>收藏</strong>
          <span className="sub">{favorites.length ? `${favorites.length} 条` : ''}</span>
        </div>
        {favorites.length === 0 ? (
          <Empty title="暂无收藏">在搜索结果或商家详情中点「收藏」，之后在这里跟踪当前价。</Empty>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>名称</th>
                <th className="num">当前价</th>
                <th className="num">涨跌</th>
                <th className="num">目标价</th>
                <th className="num">库存</th>
                <th>更新</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {favorites.map((f) => {
                const openUrl = favoriteOpenUrl(f)
                const key = favKey(f)
                const editing = editingKey === key
                const delta =
                  f.targetType === 'shop_product' ? priceDelta(f.price, f.baselinePrice) : null
                const hitTarget =
                  f.targetType === 'shop_product' &&
                  f.price != null &&
                  f.targetPrice != null &&
                  f.price <= f.targetPrice
                return (
                  <tr key={f.id} className={hitTarget ? 'fav-hit-target' : undefined}>
                    <td>
                      <div className="ellipsis" style={{ maxWidth: 300 }}>
                        {f.titleSnapshot || '（已失效或未解析）'}
                      </div>
                      {editing ? (
                        <div className="fav-edit">
                          <Input
                            className="fav-note-input"
                            placeholder="备注"
                            value={noteDraft}
                            onChange={(e) => setNoteDraft(e.target.value)}
                          />
                          {f.targetType === 'shop_product' ? (
                            <Input
                              className="fav-target-input"
                              type="number"
                              min={0}
                              step="0.01"
                              placeholder="目标价"
                              value={targetDraft}
                              onChange={(e) => setTargetDraft(e.target.value)}
                            />
                          ) : null}
                          <div className="row" style={{ gap: 8 }}>
                            <button
                              className="linkish"
                              type="button"
                              onClick={() => void saveEdit(f)}
                            >
                              保存
                            </button>
                            <button
                              className="linkish"
                              type="button"
                              onClick={() => setEditingKey(null)}
                            >
                              取消
                            </button>
                          </div>
                        </div>
                      ) : (
                        <>
                          {f.note ? <div className="small muted">{f.note}</div> : null}
                          {hitTarget ? (
                            <Badge tone="ok">达标</Badge>
                          ) : f.targetType === 'shop_product' && f.targetPrice != null ? (
                            <div className="small muted">目标 ¥{f.targetPrice}</div>
                          ) : null}
                        </>
                      )}
                    </td>
                    <td className="num">
                      {f.targetType === 'shop_product' ? (
                        <>
                          <Price price={f.price} currency={f.currency} />
                          {f.baselinePrice != null ? (
                            <div className="small muted" title="收藏时基线价">
                              基线 {f.baselinePrice}
                            </div>
                          ) : null}
                        </>
                      ) : (
                        <span className="faint">—</span>
                      )}
                    </td>
                    <td className="num">
                      {delta == null ? (
                        <span className="faint">—</span>
                      ) : (
                        <span
                          className={
                            delta < 0 ? 'delta-down' : delta > 0 ? 'delta-up' : 'muted small'
                          }
                        >
                          {formatDelta(delta)}
                        </span>
                      )}
                    </td>
                    <td className="num mono">
                      {f.targetType === 'shop_product'
                        ? f.targetPrice != null
                          ? f.targetPrice
                          : '—'
                        : '—'}
                    </td>
                    <td className="num mono">
                      {f.targetType === 'shop_product' ? (f.stock ?? '—') : '—'}
                    </td>
                    <td className="small muted" title={f.fetchedAt ?? undefined}>
                      {f.targetType === 'shop_product' ? timeAgo(f.fetchedAt) : '—'}
                    </td>
                    <td>
                      <div className="row-actions">
                        {openUrl ? (
                          <button
                            className="linkish"
                            type="button"
                            onClick={() => void openExternalSafe(openUrl)}
                          >
                            打开源站
                          </button>
                        ) : null}
                        {openUrl ? <CopyLinkButton url={openUrl} /> : null}
                        <button className="linkish" type="button" onClick={() => beginEdit(f)}>
                          编辑
                        </button>
                        {f.merchantId ? (
                          <Link
                            to={`/merchants?id=${encodeURIComponent(f.merchantId)}`}
                            className="linkish"
                          >
                            商家
                          </Link>
                        ) : null}
                        {f.targetType === 'shop_product' &&
                        resolveShopRef({
                          platformId: f.platformId,
                          shopToken: f.shopToken,
                          ldxpToken: f.ldxpToken,
                          strictPlatform: true
                        }) ? (
                          <button
                            className="linkish"
                            type="button"
                            disabled={busy || refreshing}
                            onClick={() => {
                              const ref = resolveShopRef({
                                platformId: f.platformId,
                                shopToken: f.shopToken,
                                ldxpToken: f.ldxpToken,
                                strictPlatform: true
                              })
                              if (!ref) return
                              void start('shop_one', {
                                platformId: ref.platformId,
                                token: ref.token,
                                merchantId: f.merchantId ?? undefined
                              })
                              toast('已开始刷新该店')
                            }}
                          >
                            刷新店
                          </button>
                        ) : null}
                        {f.targetType === 'shop_product' && f.titleSnapshot ? (
                          <>
                            <button
                              className="linkish"
                              type="button"
                              onClick={() => setCompareTitle(f.titleSnapshot!)}
                            >
                              比价
                            </button>
                            <Link
                              to={`/?q=${encodeURIComponent(f.titleSnapshot)}`}
                              className="linkish"
                            >
                              按标题搜
                            </Link>
                          </>
                        ) : null}
                        <button
                          className="linkish"
                          type="button"
                          onClick={() =>
                            void window.api.favorites
                              .remove({ targetType: f.targetType, targetId: f.targetId })
                              .then(() => {
                                toast('已移除收藏')
                                return reload()
                              })
                          }
                        >
                          移除
                        </button>
                      </div>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
      </div>

      <CompareDrawer
        title={compareTitle}
        onClose={() => setCompareTitle(null)}
        onOpenHit={openCompareHit}
      />
    </div>
  )
}
