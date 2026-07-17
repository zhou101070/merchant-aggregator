import { useCallback, useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import type { Merchant } from '@shared/types/merchant'
import type { ShopProduct } from '@shared/types/product'
import {
  Badge,
  Button,
  Chip,
  Empty,
  IconButton,
  Input,
  Price,
  SkeletonRows,
  StatusDot
} from '../components/ui'
import { Select } from '../components/select'
import { Icon } from '../components/icons'
import { useConfirm } from '../components/use-confirm'
import { useToast } from '../components/use-toast'
import { useSyncStatus } from '../hooks/useSync'
import { SHOP_PLATFORM_OTHER, SHOP_PROFILES } from '@shared/platforms/shop-profiles'
import { shopAllSpec } from '../lib/confirm-sync'
import { openExternalSafe } from '../lib/open-external'
import { formatSyncProgress } from '../lib/sync-labels'
import { timeAgo } from '../lib/format-time'

function healthTone(h: string | null): 'ok' | 'fail' | 'warn' | 'default' {
  if (h === 'healthy') return 'ok'
  if (h === 'failing') return 'fail'
  if (h === 'retrying') return 'warn'
  if (h === 'never') return 'warn'
  return 'default'
}

function healthLabel(h: string | null | undefined): string {
  switch (h) {
    case 'healthy':
      return '健康'
    case 'failing':
      return '异常'
    case 'retrying':
      return '同步中'
    case 'never':
      return '未同步'
    case 'n/a':
      return '不适用'
    case 'unknown':
      return '未知'
    default:
      return h?.trim() ? h : '未同步'
  }
}

/** 同名店消歧：优先 host / sourceId，否则品牌 + id 短尾 */
function merchantSubline(m: Merchant): string {
  const host = m.host?.trim()
  if (host) return host
  const sourceId = m.sourceId?.trim()
  if (sourceId) return sourceId
  const tail = m.id.replace(/^merchant-/, '').slice(-8)
  const brands = m.platforms.filter(Boolean).join(' · ')
  return brands ? `${brands} · ${tail}` : tail
}

export function MerchantsPage(): React.JSX.Element {
  const {
    status,
    progress,
    startMerchants,
    startLdxpSelected,
    startLdxpAll,
    start,
    cancelRunning,
    busy,
    error
  } = useSyncStatus()
  const confirm = useConfirm()
  const toast = useToast()
  const [q, setQ] = useState('')
  const [debouncedQ, setDebouncedQ] = useState('')
  const [rows, setRows] = useState<Merchant[]>([])
  const [total, setTotal] = useState(0)
  const [selected, setSelected] = useState<Merchant | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [searchParams, setSearchParams] = useSearchParams()
  const [checked, setChecked] = useState<Set<string>>(new Set())
  // 键控存储:渲染期按当前商家派生,切换商家瞬间不会闪旧数据
  const [shopProductsFor, setShopProductsFor] = useState<{
    id: string
    rows: ShopProduct[]
  } | null>(null)
  const [loading, setLoading] = useState(false)
  const [scrapableOnly, setScrapableOnly] = useState(false)
  const [withoutShopProducts, setWithoutShopProducts] = useState(false)
  const [healthFilter, setHealthFilter] = useState<string>('all')
  const [platformFilter, setPlatformFilter] = useState<string>('all')

  useEffect(() => {
    const t = setTimeout(() => setDebouncedQ(q.trim()), 250)
    return () => clearTimeout(t)
  }, [q])

  // 深链：/merchants?id=xxx 直达商家详情(收藏 / 最近浏览跳入)
  useEffect(() => {
    const id = searchParams.get('id')
    if (!id || id === selectedId) return
    void window.api.merchants.get(id).then((m) => {
      if (m) {
        setSelected(m)
        setSelectedId(m.id)
      }
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams])

  function selectMerchant(m: Merchant | null): void {
    setSelected(m)
    setSelectedId(m?.id ?? null)
    setSearchParams(m ? { id: m.id } : {}, { replace: true })
  }

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const res = await window.api.merchants.list({
        q: debouncedQ || undefined,
        scrapableOnly: scrapableOnly || withoutShopProducts || undefined,
        withoutShopProducts: withoutShopProducts || undefined,
        health: healthFilter === 'all' ? undefined : [healthFilter],
        shopPlatforms: platformFilter === 'all' ? undefined : [platformFilter],
        offset: 0,
        limit: 500,
        sort: 'offerCount',
        sortDir: 'desc'
      })
      setRows(res.rows)
      setTotal(res.total)
      if (selectedId) {
        // 列表刷新时同步详情数据；不在当前筛选内则保留原详情(深链场景)
        const fresh = res.rows.find((r) => r.id === selectedId)
        if (fresh) setSelected(fresh)
      }
    } finally {
      setLoading(false)
    }
  }, [debouncedQ, selectedId, scrapableOnly, withoutShopProducts, healthFilter, platformFilter])

  useEffect(() => {
    void load()
  }, [load, status?.counts.merchants, progress?.status])

  useEffect(() => {
    if (!selected) return
    let alive = true
    void window.api.shopProducts
      .list({ merchantId: selected.id, offset: 0, limit: 200 })
      .then((r) => {
        if (alive) setShopProductsFor({ id: selected.id, rows: r.rows })
      })
    void window.api.recent.touch({
      targetType: 'merchant',
      targetId: selected.id,
      titleSnapshot: selected.name
    })
    return () => {
      alive = false
    }
  }, [selected, status?.counts.shopProducts, progress?.status])
  const shopProducts = selected && shopProductsFor?.id === selected.id ? shopProductsFor.rows : []

  /** Aligned with SCRAPABLE_SQL: shop_platform + shop_token (mapRow dual-fills from ldxp). */
  const scrapable = (m: { shopPlatform?: string | null; shopToken?: string | null }): boolean =>
    !!(m.shopPlatform && m.shopToken)
  const ldxpRows = useMemo(() => rows.filter((m) => scrapable(m)), [rows])
  const checkedLdxp = useMemo(
    () => [...checked].filter((id) => rows.some((m) => m.id === id && scrapable(m))),
    [checked, rows]
  )

  function toggle(id: string, isLdxp: boolean): void {
    if (!isLdxp) return
    setChecked((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  function toggleAllLdxp(): void {
    if (checkedLdxp.length === ldxpRows.length) {
      setChecked(new Set())
    } else {
      setChecked(new Set(ldxpRows.map((m) => m.id)))
    }
  }

  async function syncAll(): Promise<void> {
    const n = status?.counts.scrapableMerchants ?? status?.counts.ldxpMerchants ?? ldxpRows.length
    if (!(await confirm(shopAllSpec(n)))) return
    void startLdxpAll()
    toast('已开始同步全部可刮店铺')
  }

  function favoriteMerchant(m: Merchant): void {
    void window.api.favorites
      .add({ targetType: 'merchant', targetId: m.id })
      .then(() => toast(`已收藏商家：${m.name}`, 'ok'))
  }

  return (
    <div className="stack page-viewport">
      <div className="page-head">
        <div>
          <h1 className="page-title">商家</h1>
          <div className="page-meta">
            本地 <span className="num">{status?.counts.merchants ?? total}</span> 家 · 可刮{' '}
            <span className="num">
              {status?.counts.scrapableMerchants ?? status?.counts.ldxpMerchants ?? 0}
            </span>{' '}
            · 店内商品 <span className="num">{status?.counts.shopProducts ?? 0}</span>
          </div>
        </div>
        <div className="page-actions">
          {busy ? (
            <Button onClick={() => void cancelRunning()}>
              <span className="spin" aria-hidden="true" />
              取消同步
            </Button>
          ) : (
            <>
              <Button onClick={() => void startMerchants()}>同步商家列表</Button>
              <Button
                disabled={!checkedLdxp.length}
                onClick={() => {
                  void startLdxpSelected(checkedLdxp)
                  toast(`已开始同步所选 ${checkedLdxp.length} 家店`)
                }}
              >
                同步所选{checkedLdxp.length ? `(${checkedLdxp.length})` : ''}
              </Button>
              <Button variant="primary" onClick={() => void syncAll()}>
                同步全部可刮店铺
              </Button>
            </>
          )}
        </div>
      </div>

      <div className="filter-bar">
        <Input
          placeholder="搜索店名 / host"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          style={{ width: 220 }}
        />
        <Chip on={scrapableOnly} onClick={() => setScrapableOnly((v) => !v)}>
          仅可深刮
        </Chip>
        <Chip
          on={withoutShopProducts}
          onClick={() => {
            setWithoutShopProducts((v) => {
              if (!v) setScrapableOnly(true)
              return !v
            })
          }}
        >
          尚未同步商品
        </Chip>
        <Select
          value={platformFilter}
          onValueChange={(v) => {
            setPlatformFilter(v)
            // 「其他」= 未注册 scrapable 平台，几乎都不可深刮；与「仅可深刮」并用必为空
            if (v === SHOP_PLATFORM_OTHER) {
              setScrapableOnly(false)
              setWithoutShopProducts(false)
            }
          }}
          ariaLabel="平台筛选"
          options={[
            { value: 'all', label: '全部平台' },
            ...SHOP_PROFILES.map((p) => ({ value: p.id, label: p.displayName })),
            { value: SHOP_PLATFORM_OTHER, label: '其他' }
          ]}
        />
        <Select
          value={healthFilter}
          onValueChange={setHealthFilter}
          ariaLabel="健康筛选"
          options={[
            { value: 'all', label: '全部状态' },
            { value: 'healthy', label: '健康' },
            { value: 'failing', label: '异常' },
            { value: 'never', label: '未同步' },
            { value: 'retrying', label: '同步中' },
            { value: 'n/a', label: '不可刮' }
          ]}
        />
        <span className="faint small">
          筛选结果 <span className="num">{total}</span> 家 · 勾选仅对可深刮店生效
        </span>
      </div>

      {error ? (
        <div className="panel" style={{ padding: '10px 14px' }}>
          <StatusDot tone="fail">{error}</StatusDot>
        </div>
      ) : null}
      {busy ? (
        <div className="panel" style={{ padding: '10px 14px' }}>
          <StatusDot tone="warn">
            同步中：{formatSyncProgress(progress ?? status?.running[0] ?? {})}
          </StatusDot>
        </div>
      ) : null}

      {loading && !rows.length ? (
        <div className="panel">
          <SkeletonRows rows={7} />
        </div>
      ) : total === 0 ? (
        <div className="panel">
          <Empty
            title={
              platformFilter !== 'all' ||
              scrapableOnly ||
              withoutShopProducts ||
              healthFilter !== 'all' ||
              debouncedQ
                ? '没有匹配的商家'
                : '还没有商家数据'
            }
            actions={
              platformFilter === 'all' &&
              !scrapableOnly &&
              !withoutShopProducts &&
              healthFilter === 'all' &&
              !debouncedQ ? (
                <Button variant="primary" onClick={() => void startMerchants()} disabled={busy}>
                  从 PriceAI 同步商家
                </Button>
              ) : (
                <Button
                  onClick={() => {
                    setPlatformFilter('all')
                    setScrapableOnly(false)
                    setWithoutShopProducts(false)
                    setHealthFilter('all')
                    setQ('')
                  }}
                >
                  清除筛选
                </Button>
              )
            }
          >
            {platformFilter === SHOP_PLATFORM_OTHER
              ? '「其他」为非链动/catfk 等未注册发卡站；不要与「仅可深刮」同时开启。'
              : platformFilter !== 'all' ||
                  scrapableOnly ||
                  withoutShopProducts ||
                  healthFilter !== 'all' ||
                  debouncedQ
                ? '试试放宽平台、健康状态或可深刮条件。'
                : '商家主档来自 PriceAI，只需同步一次，之后按需更新。'}
          </Empty>
        </div>
      ) : (
        <div className={`panel panel-fill ${selected ? 'split' : ''}`}>
          <div className="list-side">
            <table className="table">
              <thead>
                <tr>
                  <th className="col-check">
                    <input
                      type="checkbox"
                      className="checkbox"
                      checked={ldxpRows.length > 0 && checkedLdxp.length === ldxpRows.length}
                      onChange={toggleAllLdxp}
                      title="全选可刮店铺"
                      aria-label="全选可刮店铺"
                    />
                  </th>
                  <th>店名</th>
                  <th>同步状态</th>
                  <th className="num">本地商品</th>
                  <th className="col-host">host</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((m) => {
                  const canScrape = scrapable(m)
                  const isSelected = m.id === selectedId
                  return (
                    <tr
                      key={m.id}
                      className={isSelected ? 'selected' : ''}
                      onClick={() => selectMerchant(m)}
                      style={{ cursor: 'pointer' }}
                    >
                      <td onClick={(e) => e.stopPropagation()}>
                        <input
                          type="checkbox"
                          className="checkbox"
                          disabled={!canScrape}
                          checked={checked.has(m.id)}
                          onChange={() => toggle(m.id, canScrape)}
                          aria-label={`勾选 ${m.name}`}
                        />
                      </td>
                      <td title={m.id}>
                        <div className="ellipsis" style={{ maxWidth: 260 }}>
                          {m.name}
                        </div>
                        <div className="faint small mono ellipsis" style={{ maxWidth: 260 }}>
                          {merchantSubline(m)}
                        </div>
                      </td>
                      <td className="nowrap">
                        <StatusDot tone={healthTone(m.healthStatus)}>
                          {healthLabel(m.healthStatus)}
                        </StatusDot>
                        {m.healthCheckedAt ? (
                          <span className="faint small"> · {timeAgo(m.healthCheckedAt)}</span>
                        ) : null}
                      </td>
                      <td className="num mono">
                        {m.localProductCount > 0 ? m.localProductCount : '—'}
                      </td>
                      <td className="mono muted col-host">{m.host ?? '—'}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>

          {selected ? (
            <div className="detail-pane">
              <div className="row between" style={{ alignItems: 'flex-start', flexWrap: 'nowrap' }}>
                <div style={{ minWidth: 0 }}>
                  <h2 className="detail-title">{selected.name}</h2>
                  <div className="detail-id">{selected.id}</div>
                </div>
                <IconButton label="关闭详情" onClick={() => selectMerchant(null)}>
                  <Icon name="close" />
                </IconButton>
              </div>

              <div className="row">
                <StatusDot tone={healthTone(selected.healthStatus)}>
                  同步：{healthLabel(selected.healthStatus)}
                </StatusDot>
                {selected.upstreamHealth ? <Badge>上游：{selected.upstreamHealth}</Badge> : null}
                {selected.shopToken || selected.ldxpToken ? (
                  <span className="mono faint">
                    {selected.shopPlatform || 'ldxp'}:{selected.shopToken || selected.ldxpToken}
                  </span>
                ) : null}
              </div>

              {selected.healthMessage ? (
                <div className="small muted">
                  {selected.healthMessage}
                  {selected.healthCheckedAt ? ` · ${timeAgo(selected.healthCheckedAt)}` : ''}
                </div>
              ) : selected.healthCheckedAt ? (
                <div className="small muted">上次同步：{timeAgo(selected.healthCheckedAt)}</div>
              ) : null}

              <div className="tag-line">
                平台：{selected.platforms.join(' · ') || '—'}
                <br />
                店内商品（本地）：<span className="num">{shopProducts.length}</span>
              </div>

              <div className="row">
                <Button
                  variant="primary"
                  onClick={() => void openExternalSafe(selected.shopUrl ?? selected.entryUrl)}
                >
                  <Icon name="external" size={14} />
                  打开店铺
                </Button>
                {scrapable(selected) ? (
                  <Button
                    disabled={busy}
                    onClick={() => {
                      void start('shop_one', {
                        merchantId: selected.id,
                        platformId: selected.shopPlatform || 'ldxp',
                        token: selected.shopToken || selected.ldxpToken || undefined
                      })
                      toast(`已开始同步：${selected.name}`)
                    }}
                  >
                    <Icon name="refresh" size={14} />
                    同步该店商品
                  </Button>
                ) : null}
                <Button onClick={() => favoriteMerchant(selected)}>
                  <Icon name="bookmark" size={14} />
                  收藏
                </Button>
              </div>
              {!scrapable(selected) ? (
                <div className="faint small">
                  该店无可刮店铺信息：只能打开外链，无法同步店内价。
                </div>
              ) : null}

              <div className="panel detail-products" style={{ boxShadow: 'none' }}>
                <div className="panel-head">
                  <strong>店内商品</strong>
                  <span className="sub">
                    {shopProducts.length ? `${shopProducts.length} 条` : ''}
                  </span>
                </div>
                {!shopProducts.length ? (
                  <Empty title="该店尚未同步商品">
                    {scrapable(selected)
                      ? '点上方「同步该店商品」拉取店内价格。'
                      : '该店不支持同步店内价。'}
                  </Empty>
                ) : (
                  <div>
                    <table className="table">
                      <thead>
                        <tr>
                          <th className="col-title">商品</th>
                          <th className="num col-price">价格</th>
                          <th className="num col-stock">库存</th>
                          <th className="col-actions"></th>
                        </tr>
                      </thead>
                      <tbody>
                        {shopProducts.map((p) => (
                          <tr key={p.id}>
                            <td className="col-title">
                              <div className="ellipsis" title={p.title}>
                                {p.title}
                              </div>
                            </td>
                            <td className="num col-price">
                              <Price price={p.price} currency={p.currency} />
                            </td>
                            <td className="num mono col-stock">{p.stock ?? '—'}</td>
                            <td className="col-actions">
                              <IconButton
                                label="打开源站"
                                onClick={() => void openExternalSafe(p.sourceUrl)}
                              >
                                <Icon name="external" size={14} />
                              </IconButton>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            </div>
          ) : null}
        </div>
      )}
    </div>
  )
}
