import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Merchant } from '@shared/types/merchant'
import type { ShopProduct } from '@shared/types/product'
import { Badge, Button, Chip, Empty, IconButton, Input, Price, Switch } from './ui'
import { FilterBar } from './layout'
import { HealthStatus } from './health-status'
import { ModalDialog, ModalDialogTitle } from './modal-dialog'
import { useModalDismiss } from './use-modal-dismiss'
import { Icon } from './icons'
import { useToast } from './use-toast'
import { useRefreshStock } from '../hooks/useRefreshStock'
import { useSyncStatus } from '../hooks/useSync'
import { openExternalSafe } from '../lib/open-external'
import { merchantStoreUrl } from '../lib/shop-url'
import {
  canSyncShopProducts,
  canTrialUnknownShopSync,
  resolveShopIdentity,
  resolveShopSyncStartRef
} from '../lib/shop-ref'
import { timeAgo } from '../lib/format-time'
import { filterAndRankShopProducts } from '@shared/lib/shop-product-match'

type ProductSortKey = 'title' | 'price' | 'stock'
type ProductSortDir = 'asc' | 'desc'

function defaultDirFor(key: ProductSortKey): ProductSortDir {
  if (key === 'price' || key === 'stock' || key === 'title') return 'asc'
  return 'desc'
}

function compareNullableNumber(
  a: number | null | undefined,
  b: number | null | undefined,
  dir: ProductSortDir
): number {
  const aOk = typeof a === 'number' && Number.isFinite(a)
  const bOk = typeof b === 'number' && Number.isFinite(b)
  if (!aOk && !bOk) return 0
  if (!aOk) return 1
  if (!bOk) return -1
  const d = (a as number) - (b as number)
  return dir === 'asc' ? d : -d
}

function sortShopProducts(
  rows: ShopProduct[],
  sort: ProductSortKey,
  sortDir: ProductSortDir
): ShopProduct[] {
  const out = [...rows]
  out.sort((a, b) => {
    if (sort === 'title') {
      const d = a.title.localeCompare(b.title, 'zh-CN')
      return sortDir === 'asc' ? d : -d
    }
    if (sort === 'price') return compareNullableNumber(a.price, b.price, sortDir)
    return compareNullableNumber(a.stock, b.stock, sortDir)
  })
  return out
}

function ProductSortTh({
  label,
  col,
  sort,
  sortDir,
  onSort,
  className
}: {
  label: string
  col: ProductSortKey
  sort: ProductSortKey
  sortDir: ProductSortDir
  onSort: (col: ProductSortKey) => void
  className?: string
}): React.JSX.Element {
  const active = sort === col
  const mark = active ? (sortDir === 'asc' ? ' ↑' : ' ↓') : ''
  return (
    <th className={className}>
      <button
        type="button"
        className={`th-sort${active ? ' on' : ''}`}
        onClick={() => onSort(col)}
        aria-sort={active ? (sortDir === 'asc' ? 'ascending' : 'descending') : 'none'}
      >
        {label}
        <span className="th-sort-mark" aria-hidden>
          {mark || ' ↕'}
        </span>
      </button>
    </th>
  )
}

function productGroupLabel(t: string): string {
  switch (t) {
    case 'card':
      return '卡密'
    case 'article':
      return '文章'
    case 'resource':
      return '资源'
    case 'equity':
      return '权益'
    default:
      return t
  }
}

function productGroupKey(p: ShopProduct): string {
  const cat = p.categoryName?.trim()
  if (cat) return cat
  const gt = p.goodsType?.trim()
  if (gt) return gt
  return ''
}

function isInStock(p: ShopProduct): boolean {
  return typeof p.stock === 'number' && p.stock > 0
}

export function MerchantDetailDialog({
  merchant,
  shopProducts,
  busy,
  refreshingStockId,
  onClose,
  onSyncShop,
  onFavorite,
  onRefreshStock,
  onBlockStateChange
}: {
  merchant: Merchant
  shopProducts: ShopProduct[]
  busy: boolean
  refreshingStockId: string | null
  onClose: () => void
  onSyncShop: (m: Merchant) => void
  onFavorite: (m: Merchant) => void
  onRefreshStock: (p: ShopProduct) => void
  onBlockStateChange?: (blocked: boolean) => void
}): React.JSX.Element {
  return (
    <ModalDialog
      openKey={merchant.id}
      className="dialog dialog-wide dialog-merchant"
      onClose={onClose}
    >
      <MerchantDetailBody
        merchant={merchant}
        shopProducts={shopProducts}
        busy={busy}
        refreshingStockId={refreshingStockId}
        onSyncShop={onSyncShop}
        onFavorite={onFavorite}
        onRefreshStock={onRefreshStock}
        onBlockStateChange={onBlockStateChange}
      />
    </ModalDialog>
  )
}

function MerchantDetailBody({
  merchant,
  shopProducts,
  busy,
  refreshingStockId,
  onSyncShop,
  onFavorite,
  onRefreshStock,
  onBlockStateChange
}: {
  merchant: Merchant
  shopProducts: ShopProduct[]
  busy: boolean
  refreshingStockId: string | null
  onSyncShop: (m: Merchant) => void
  onFavorite: (m: Merchant) => void
  onRefreshStock: (p: ShopProduct) => void
  onBlockStateChange?: (blocked: boolean) => void
}): React.JSX.Element {
  const dismiss = useModalDismiss()
  const toast = useToast()
  const identity = resolveShopIdentity(merchant)
  const canSync = canSyncShopProducts(merchant)
  const trialSync = canTrialUnknownShopSync(merchant)
  const [blocked, setBlocked] = useState(false)
  const [blockBusy, setBlockBusy] = useState(false)
  const [groupFilter, setGroupFilter] = useState<string>('all')
  const [productQ, setProductQ] = useState('')
  /** 默认只看有货，与搜索页一致 */
  const [inStockOnly, setInStockOnly] = useState(true)
  const [sort, setSort] = useState<ProductSortKey>('price')
  const [sortDir, setSortDir] = useState<ProductSortDir>('asc')
  const groupFilterKey = merchant.id
  const [seenMerchantId, setSeenMerchantId] = useState(groupFilterKey)
  if (groupFilterKey !== seenMerchantId) {
    setSeenMerchantId(groupFilterKey)
    setGroupFilter('all')
    setProductQ('')
    setInStockOnly(true)
    setSort('price')
    setSortDir('asc')
    setBlocked(false)
  }

  useEffect(() => {
    let alive = true
    void window.api.blocklist.list().then((rows) => {
      if (!alive) return
      setBlocked(rows.some((r) => r.targetType === 'merchant' && r.targetId === merchant.id))
    })
    return () => {
      alive = false
    }
  }, [merchant.id])

  async function toggleBlock(): Promise<void> {
    if (blockBusy) return
    setBlockBusy(true)
    try {
      if (blocked) {
        await window.api.blocklist.remove({ targetType: 'merchant', targetId: merchant.id })
        setBlocked(false)
        onBlockStateChange?.(false)
        toast(`已解除屏蔽：${merchant.name}`, 'ok')
      } else {
        await window.api.blocklist.add({
          targetType: 'merchant',
          targetId: merchant.id,
          titleSnapshot: merchant.name
        })
        setBlocked(true)
        onBlockStateChange?.(true)
        toast(`已屏蔽商家：${merchant.name}（列表与搜索不再显示）`, 'ok')
      }
    } finally {
      setBlockBusy(false)
    }
  }

  const stockScopedProducts = useMemo(() => {
    if (!inStockOnly) return shopProducts
    return shopProducts.filter(isInStock)
  }, [shopProducts, inStockOnly])

  const productGroups = useMemo(() => {
    const counts = new Map<string, number>()
    let ungrouped = 0
    for (const p of stockScopedProducts) {
      const key = productGroupKey(p)
      if (!key) {
        ungrouped += 1
        continue
      }
      counts.set(key, (counts.get(key) ?? 0) + 1)
    }
    const groups = [...counts.entries()]
      .map(([key, count]) => ({ key, count, label: productGroupLabel(key) }))
      .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label, 'zh-CN'))
    if (ungrouped > 0) {
      groups.push({ key: '__none__', count: ungrouped, label: '未分组' })
    }
    return groups
  }, [stockScopedProducts])

  const filteredProducts = useMemo(() => {
    let rows = stockScopedProducts
    if (groupFilter === '__none__') {
      rows = rows.filter((p) => !productGroupKey(p))
    } else if (groupFilter !== 'all') {
      rows = rows.filter((p) => productGroupKey(p) === groupFilter)
    }
    if (productQ.trim()) {
      // 有关键词时先按相关度排，再按用户点选的列稳定重排
      rows = filterAndRankShopProducts(rows, productQ)
    }
    return sortShopProducts(rows, sort, sortDir)
  }, [stockScopedProducts, groupFilter, productQ, sort, sortDir])

  function setSortKey(key: ProductSortKey): void {
    if (key === sort) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'))
    } else {
      setSort(key)
      setSortDir(defaultDirFor(key))
    }
  }

  const hasListFilter =
    productQ.trim().length > 0 ||
    groupFilter !== 'all' ||
    (inStockOnly && stockScopedProducts.length !== shopProducts.length)

  return (
    <>
      <div className="dialog-head">
        <div style={{ minWidth: 0, flex: 1 }}>
          <ModalDialogTitle className="dialog-title" title={merchant.name}>
            {merchant.name}
          </ModalDialogTitle>
        </div>
        <IconButton label="关闭" autoFocus onClick={() => dismiss()}>
          <Icon name="close" />
        </IconButton>
      </div>
      <div className="dialog-body">
      <div className="row" style={{ marginBottom: 8 }}>
        <HealthStatus health={merchant.healthStatus} prefix="同步：" />
        <Badge tone={identity.scrapable ? 'ok' : 'default'}>{identity.label}</Badge>
        {merchant.healthCheckedAt ? (
          <span className="small muted">上次同步 {timeAgo(merchant.healthCheckedAt)}</span>
        ) : null}
      </div>

      {merchant.healthMessage ? (
        <div className="small muted" style={{ marginBottom: 8 }}>
          {merchant.healthMessage}
        </div>
      ) : null}

      <div className="row merchant-detail-actions" style={{ marginBottom: 12 }}>
        <Button
          variant="primary"
          onClick={() => void openExternalSafe(merchantStoreUrl(merchant))}
        >
          <Icon name="external" size={14} />
          打开店铺
        </Button>
        {canSync ? (
          <Button disabled={busy} onClick={() => onSyncShop(merchant)}>
            <Icon name="refresh" size={14} />
            同步该店商品
          </Button>
        ) : null}
        <Button onClick={() => onFavorite(merchant)}>
          <Icon name="bookmark" size={14} />
          收藏
        </Button>
        <Button
          className="merchant-detail-block"
          variant={blocked ? 'ok' : 'danger'}
          disabled={blockBusy}
          onClick={() => void toggleBlock()}
          title={
            blocked
              ? '解除屏蔽后，搜索将重新显示该店商品'
              : '屏蔽后搜索不再显示该店商品'
          }
        >
          {blocked ? '取消屏蔽' : '屏蔽商家'}
        </Button>
      </div>
      {!identity.scrapable && trialSync ? (
        <div className="faint small" style={{ marginBottom: 12 }}>
          未知平台：将依次尝试已有同步模式；全部失败时静默跳过，不加入屏蔽。
        </div>
      ) : null}
      {!canSync ? (
        <div className="faint small" style={{ marginBottom: 12 }}>
          {identity.reason}。只能打开外链，无法同步店内价。
        </div>
      ) : null}

      <div className="merchant-dialog-products">
        <div className="merchant-products-title">
          <strong>店内商品</strong>
          {shopProducts.length ? (
            <span className="sub">
              {hasListFilter
                ? `${filteredProducts.length}/${shopProducts.length} 条`
                : `${shopProducts.length} 条`}
            </span>
          ) : null}
          {shopProducts.length ? (
            <label className="in-stock-toggle" title="关闭后显示已同步的售罄商品">
              <Switch label="只看有货" checked={inStockOnly} onChange={setInStockOnly} />
              <span>只看有货</span>
            </label>
          ) : null}
        </div>
        {stockScopedProducts.length && productGroups.length > 0 ? (
          <FilterBar label="分组" style={{ padding: '0 0 10px' }}>
            <Chip on={groupFilter === 'all'} onClick={() => setGroupFilter('all')}>
              全部商品
              <span className="faint"> {stockScopedProducts.length}</span>
            </Chip>
            {productGroups.map((g) => (
              <Chip key={g.key} on={groupFilter === g.key} onClick={() => setGroupFilter(g.key)}>
                {g.label}
                <span className="faint"> {g.count}</span>
              </Chip>
            ))}
          </FilterBar>
        ) : null}
        {shopProducts.length ? (
          <div className="merchant-product-search">
            <Icon name="search" size={14} />
            <Input
              className="merchant-product-search-input"
              placeholder="搜商品名 / 分组"
              value={productQ}
              onChange={(e) => setProductQ(e.target.value)}
              aria-label="搜索店内商品"
            />
          </div>
        ) : null}
        {!shopProducts.length ? (
          <Empty title="该店尚未同步商品">
            {canSync
              ? trialSync
                ? '点上方「同步该店商品」尝试已有模式拉取店内价格。'
                : '点上方「同步该店商品」拉取店内价格。'
              : '该店不支持同步店内价。'}
          </Empty>
        ) : !filteredProducts.length ? (
          <Empty
            title={
              productQ.trim()
                ? '没有匹配的商品'
                : inStockOnly && stockScopedProducts.length === 0
                  ? '没有有货商品'
                  : '该分组下无商品'
            }
          >
            {productQ.trim()
              ? '试试换个关键词，或清空搜索。'
              : inStockOnly && stockScopedProducts.length === 0
                ? '关闭「只看有货」可查看售罄商品，或重新同步该店。'
                : '换一个分组，或选「全部商品」。'}
          </Empty>
        ) : (
          <div className="merchant-dialog-table-wrap">
            <table className="table detail-products">
              <thead>
                <tr>
                  <ProductSortTh
                    label="商品"
                    col="title"
                    sort={sort}
                    sortDir={sortDir}
                    onSort={setSortKey}
                    className="col-title"
                  />
                  <ProductSortTh
                    label="价格"
                    col="price"
                    sort={sort}
                    sortDir={sortDir}
                    onSort={setSortKey}
                    className="num col-price"
                  />
                  <ProductSortTh
                    label="库存"
                    col="stock"
                    sort={sort}
                    sortDir={sortDir}
                    onSort={setSortKey}
                    className="num col-stock"
                  />
                  <th className="col-actions"></th>
                </tr>
              </thead>
              <tbody>
                {filteredProducts.map((p) => (
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
                      <div className="row-actions">
                        <button
                          className="linkish"
                          disabled={refreshingStockId === p.id}
                          title="按商品刷新库存（非整店）"
                          onClick={() => onRefreshStock(p)}
                        >
                          {refreshingStockId === p.id ? '刷新中…' : '刷新库存'}
                        </button>
                        <IconButton
                          label="打开源站"
                          onClick={() => void openExternalSafe(p.sourceUrl)}
                        >
                          <Icon name="external" size={14} />
                        </IconButton>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
      </div>
    </>
  )
}

/** 按 merchantId 加载并展示详情弹窗（搜索等页就地打开，不跳转商家页） */
export function MerchantDetailById({
  merchantId,
  onClose
}: {
  merchantId: string
  onClose: () => void
}): React.JSX.Element {
  const toast = useToast()
  const { busy, start, status, progress } = useSyncStatus()
  const { refreshingStockId, refreshStock } = useRefreshStock()
  const [merchant, setMerchant] = useState<Merchant | null>(null)
  const [shopProducts, setShopProducts] = useState<ShopProduct[]>([])
  const [loadError, setLoadError] = useState<string | null>(null)
  const onCloseRef = useRef(onClose)
  useEffect(() => {
    onCloseRef.current = onClose
  }, [onClose])

  const reload = useCallback(async () => {
    setLoadError(null)
    const m = await window.api.merchants.get(merchantId)
    if (!m) {
      setMerchant(null)
      setLoadError('未找到该商家')
      toast('未找到该商家', 'fail')
      return
    }
    setMerchant(m)
    const r = await window.api.shopProducts.list({ merchantId: m.id, offset: 0, limit: 200 })
    setShopProducts(r.rows)
    void window.api.recent.touch({
      targetType: 'merchant',
      targetId: m.id,
      titleSnapshot: m.name
    })
  }, [merchantId, toast])

  useEffect(() => {
    let alive = true
    void (async () => {
      await reload()
      if (!alive) return
    })()
    return () => {
      alive = false
    }
  }, [reload, status?.counts.shopProducts, progress?.status])

  // 加载中 / 失败也先挂弹层，避免「点了没反应」
  if (!merchant) {
    return (
      <ModalDialog openKey={`loading-${merchantId}`} className="dialog dialog-wide" onClose={onClose}>
        <div className="dialog-head">
          <ModalDialogTitle className="dialog-title">商家详情</ModalDialogTitle>
          <IconButton label="关闭" onClick={onClose}>
            <Icon name="close" />
          </IconButton>
        </div>
        <div className="dialog-body">
          {loadError ? (
            <p className="small warn-text" style={{ margin: '12px 0' }}>
              {loadError}
            </p>
          ) : (
            <p className="muted" style={{ margin: '12px 0' }}>
              加载中…
            </p>
          )}
        </div>
      </ModalDialog>
    )
  }

  return (
    <MerchantDetailDialog
      merchant={merchant}
      shopProducts={shopProducts}
      busy={busy}
      refreshingStockId={refreshingStockId}
      onClose={onClose}
      onSyncShop={(m) => {
        const r = resolveShopSyncStartRef({ ...m, merchantId: m.id })
        if (!r) return
        void start('shop_one', {
          merchantId: m.id,
          platformId: r.platformId,
          token: r.token
        })
        toast(`已开始同步：${m.name}`)
      }}
      onFavorite={(m) => {
        void window.api.favorites
          .add({ targetType: 'merchant', targetId: m.id })
          .then(() => toast(`已收藏商家：${m.name}`, 'ok'))
      }}
      onRefreshStock={(p) =>
        void refreshStock(p.id, {
          onUpdated: (res) =>
            setShopProducts((rows) => rows.map((row) => (row.id === p.id ? res.product : row))),
          onRemoved: () => setShopProducts((rows) => rows.filter((row) => row.id !== p.id))
        })
      }
    />
  )
}
