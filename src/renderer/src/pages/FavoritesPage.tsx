import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import type { Favorite, RecentView } from '@shared/types/favorites'
import { Button, Empty, IconButton, Price } from '../components/ui'
import { Icon } from '../components/icons'
import { useToast } from '../components/use-toast'
import { useSyncStatus } from '../hooks/useSync'
import { openExternalSafe } from '../lib/open-external'
import { timeAgo } from '../lib/format-time'
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
    if (f.platformId && f.targetId) {
      // targetId is goods id: source:token:key
      return itemUrlFromProductId(f.targetId)
    }
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
    const platformId = f.platformId
    const token = f.shopToken || f.ldxpToken
    if (!platformId || !token) continue
    const key = `${platformId}\0${token}`
    const prev = map.get(key)
    if (!prev) {
      map.set(key, {
        platformId,
        token,
        merchantId: f.merchantId ?? undefined
      })
    } else if (!prev.merchantId && f.merchantId) {
      prev.merchantId = f.merchantId
    }
  }
  return [...map.values()]
}

export function FavoritesPage(): React.JSX.Element {
  const navigate = useNavigate()
  const toast = useToast()
  const { start, busy, progress, status } = useSyncStatus()
  const [favorites, setFavorites] = useState<Favorite[]>([])
  const [recent, setRecent] = useState<RecentView[]>([])
  const [refreshing, setRefreshing] = useState(false)

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

  async function refreshFavoriteShops(): Promise<void> {
    if (!refreshTargets.length || busy || refreshing) return
    setRefreshing(true)
    toast(`将刷新 ${refreshTargets.length} 家收藏相关店铺`)
    try {
      // §8: N × shop_one with platformId+token (orphans OK without merchantId)
      // Sequential: shop lane is exclusive; start waits for previous to free via busy check is racy,
      // so fire one-by-one awaiting status between jobs is heavy — queue via sequential start after
      // previous finishes by polling status briefly.
      for (let i = 0; i < refreshTargets.length; i++) {
        const t = refreshTargets[i]
        // Wait until no shop/priceai job running
        for (let w = 0; w < 600; w++) {
          const s = await window.api.sync.status()
          if (!s.running.length) break
          await new Promise((r) => setTimeout(r, 250))
        }
        await window.api.sync.start({
          jobType: 'shop_one',
          platformId: t.platformId,
          token: t.token,
          merchantId: t.merchantId
        })
      }
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'fail')
    } finally {
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

  return (
    <div className="stack">
      <div className="page-head">
        <div>
          <h1 className="page-title">收藏与最近</h1>
          <div className="page-meta">价格与库存来自本地库；刷新收藏的店可更新当前价</div>
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
                <th className="num">库存</th>
                <th>更新</th>
                <th>类型</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {favorites.map((f) => {
                const openUrl = favoriteOpenUrl(f)
                return (
                  <tr key={f.id}>
                    <td>
                      <div className="ellipsis" style={{ maxWidth: 340 }}>
                        {f.titleSnapshot || '（已失效或未解析）'}
                      </div>
                      {f.note ? <div className="small muted">{f.note}</div> : null}
                      {f.platformId ? (
                        <div className="mono faint small">
                          {f.platformId}
                          {f.shopToken || f.ldxpToken ? `:${f.shopToken || f.ldxpToken}` : ''}
                        </div>
                      ) : null}
                    </td>
                    <td className="num">
                      {f.targetType === 'shop_product' ? (
                        <Price price={f.price} currency={f.currency} />
                      ) : (
                        <span className="faint">—</span>
                      )}
                    </td>
                    <td className="num mono">
                      {f.targetType === 'shop_product' ? (f.stock ?? '—') : '—'}
                    </td>
                    <td className="small muted" title={f.fetchedAt ?? undefined}>
                      {f.targetType === 'shop_product' ? timeAgo(f.fetchedAt) : '—'}
                    </td>
                    <td className="small muted">{typeLabel(f.targetType)}</td>
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
                        {f.merchantId ? (
                          <Link
                            to={`/merchants?id=${encodeURIComponent(f.merchantId)}`}
                            className="linkish"
                          >
                            商家
                          </Link>
                        ) : null}
                        {f.targetType === 'shop_product' &&
                        f.platformId &&
                        (f.shopToken || f.ldxpToken) ? (
                          <button
                            className="linkish"
                            type="button"
                            disabled={busy || refreshing}
                            onClick={() => {
                              void start('shop_one', {
                                platformId: f.platformId!,
                                token: (f.shopToken || f.ldxpToken)!,
                                merchantId: f.merchantId ?? undefined
                              })
                              toast('已开始刷新该店')
                            }}
                          >
                            刷新店
                          </button>
                        ) : null}
                        {f.targetType === 'shop_product' && f.titleSnapshot ? (
                          <Link
                            to={`/?q=${encodeURIComponent(f.titleSnapshot)}`}
                            className="linkish"
                          >
                            去比价
                          </Link>
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

      <div className="panel">
        <div className="panel-head">
          <strong>最近浏览</strong>
          <span className="sub">商家直达详情；商品可开源站或按标题重搜</span>
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
                      {itemUrl ? (
                        <div className="row-actions">
                          <IconButton
                            label="打开源站"
                            onClick={() => void openExternalSafe(itemUrl)}
                          >
                            <Icon name="external" size={14} />
                          </IconButton>
                        </div>
                      ) : null}
                    </td>
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
