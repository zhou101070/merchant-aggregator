import { useCallback, useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import type { Merchant } from '@shared/types/merchant'
import type { ShopProduct } from '@shared/types/product'
import { Badge, Button, Empty, Input, SkeletonRows, StatusDot } from '../components/ui'
import { FilterBar, PageHeader } from '../components/layout'
import { HealthStatus } from '../components/health-status'
import { Select } from '../components/select'
import { MerchantDetailDialog } from '../components/merchant-detail-dialog'
import { useConfirm } from '../components/use-confirm'
import { useToast } from '../components/use-toast'
import { useDebouncedValue } from '../hooks/useDebouncedValue'
import { useRefreshStock } from '../hooks/useRefreshStock'
import { useSyncStatus } from '../hooks/useSync'
import { DUJIAO_PLATFORM_ID, YICIYUAN_PLATFORM_ID } from '@shared/platforms/identify'
import { SHOP_PLATFORM_OTHER, SHOP_PROFILES } from '@shared/platforms/shop-profiles'
import { shopAllSpec } from '../lib/confirm-sync'
import { resolveShopIdentity, resolveShopRef } from '../lib/shop-ref'
import { formatSyncProgress } from '../lib/sync-labels'
import { timeAgo } from '../lib/format-time'

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
    startShopSelected,
    startShopAll,
    start,
    cancelRunning,
    busy,
    error
  } = useSyncStatus()
  const confirm = useConfirm()
  const toast = useToast()
  const { refreshingStockId, refreshStock } = useRefreshStock()
  const [q, setQ] = useState('')
  const [debouncedQ] = useDebouncedValue(q.trim(), 250)
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
  const [healthFilter, setHealthFilter] = useState<string>('all')
  const [platformFilter, setPlatformFilter] = useState<string>('all')

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
  }, [debouncedQ, selectedId, healthFilter, platformFilter])

  // Mid-batch shop sync keeps progress.status=running; advance current/message after each shop
  const shopSyncTick =
    progress &&
    (progress.jobType === 'shop_one' ||
      progress.jobType === 'shop_selected' ||
      progress.jobType === 'shop_all' ||
      progress.jobType === 'bootstrap' ||
      progress.jobType === 'ldxp_shop' ||
      progress.jobType === 'ldxp_selected' ||
      progress.jobType === 'ldxp_all')
      ? `${progress.jobId}:${progress.status}:${progress.current}:${progress.phase === 'shop' ? progress.message ?? '' : progress.phase}`
      : `${progress?.jobId ?? ''}:${progress?.status ?? ''}`

  useEffect(() => {
    void load()
  }, [load, status?.counts.merchants, status?.counts.shopProducts, shopSyncTick])

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
  }, [selected, status?.counts.shopProducts, shopSyncTick])
  const shopProducts = selected && shopProductsFor?.id === selected.id ? shopProductsFor.rows : []

  function refreshProductStock(p: ShopProduct): void {
    void refreshStock(p.id, {
      onUpdated: (res) =>
        setShopProductsFor((prev) =>
          prev && prev.id === selected?.id
            ? {
                id: prev.id,
                rows: prev.rows.map((row) => (row.id === p.id ? res.product : row))
              }
            : prev
        ),
      onRemoved: () =>
        setShopProductsFor((prev) =>
          prev && prev.id === selected?.id
            ? { id: prev.id, rows: prev.rows.filter((row) => row.id !== p.id) }
            : prev
        )
    })
  }

  /** Aligned with identify + SCRAPABLE_SQL (mapRow dual-fills from ldxp). */
  const scrapable = (m: Merchant): boolean => resolveShopIdentity(m).scrapable
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
    void startShopAll()
    toast('已开始同步全部可刮店铺')
  }

  function favoriteMerchant(m: Merchant): void {
    void window.api.favorites
      .add({ targetType: 'merchant', targetId: m.id })
      .then(() => toast(`已收藏商家：${m.name}`, 'ok'))
  }

  return (
    <div className="stack page-viewport">
      <PageHeader
        title="商家"
        meta={
          <>
            本地 <span className="num">{status?.counts.merchants ?? total}</span> 家 · 可刮{' '}
            <span className="num">
              {status?.counts.scrapableMerchants ?? status?.counts.ldxpMerchants ?? 0}
            </span>{' '}
            · 店内商品 <span className="num">{status?.counts.shopProducts ?? 0}</span>
          </>
        }
        actions={
          busy ? (
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
                  void startShopSelected(checkedLdxp)
                  toast(`已开始同步所选 ${checkedLdxp.length} 家店`)
                }}
              >
                同步所选{checkedLdxp.length ? `(${checkedLdxp.length})` : ''}
              </Button>
              <Button variant="primary" onClick={() => void syncAll()}>
                同步全部可刮店铺
              </Button>
            </>
          )
        }
      />

      <FilterBar>
        <Input
          placeholder="搜索店名 / host"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          style={{ width: 220 }}
        />
        <Select
          value={platformFilter}
          onValueChange={setPlatformFilter}
          ariaLabel="平台筛选"
          options={[
            { value: 'all', label: '全部平台' },
            ...SHOP_PROFILES.map((p) => ({ value: p.id, label: p.displayName })),
            { value: DUJIAO_PLATFORM_ID, label: '独角数卡' },
            { value: YICIYUAN_PLATFORM_ID, label: '异次元发卡' },
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
      </FilterBar>

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
              platformFilter !== 'all' || healthFilter !== 'all' || debouncedQ
                ? '没有匹配的商家'
                : '还没有商家数据'
            }
            actions={
              platformFilter === 'all' && healthFilter === 'all' && !debouncedQ ? (
                <Button variant="primary" onClick={() => void startMerchants()} disabled={busy}>
                  从 PriceAI 同步商家
                </Button>
              ) : (
                <Button
                  onClick={() => {
                    setPlatformFilter('all')
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
              ? '「其他」为非链动/catfk 等未注册发卡站。'
              : platformFilter !== 'all' || healthFilter !== 'all' || debouncedQ
                ? '试试放宽平台或健康状态筛选。'
                : '商家主档来自 PriceAI，只需同步一次，之后按需更新。'}
          </Empty>
        </div>
      ) : (
        <div className="panel panel-fill">
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
                  <th>类型</th>
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
                        {(() => {
                          const id = resolveShopIdentity(m)
                          return (
                            <span title={id.reason}>
                              <Badge tone={id.scrapable ? 'ok' : 'default'}>{id.label}</Badge>
                            </span>
                          )
                        })()}
                      </td>
                      <td className="nowrap">
                        <HealthStatus health={m.healthStatus} />
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
        </div>
      )}

      {selected ? (
        <MerchantDetailDialog
          merchant={selected}
          shopProducts={shopProducts}
          busy={busy}
          refreshingStockId={refreshingStockId}
          onClose={() => selectMerchant(null)}
          onSyncShop={(m) => {
            const r = resolveShopRef(m)
            if (!r) return
            void start('shop_one', {
              merchantId: m.id,
              platformId: r.platformId,
              token: r.token
            })
            toast(`已开始同步：${m.name}`)
          }}
          onFavorite={favoriteMerchant}
          onRefreshStock={refreshProductStock}
          onBlockStateChange={() => void load()}
        />
      ) : null}
    </div>
  )
}
