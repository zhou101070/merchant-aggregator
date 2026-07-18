import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Merchant } from '@shared/types/merchant'
import type { ShopProduct } from '@shared/types/product'
import { Badge, Button, Chip, Empty, IconButton, Price } from './ui'
import { FilterBar, PanelHeader } from './layout'
import { HealthStatus } from './health-status'
import { ModalDialog } from './modal-dialog'
import { useModalDismiss } from './use-modal-dismiss'
import { Icon } from './icons'
import { useToast } from './use-toast'
import { useRefreshStock } from '../hooks/useRefreshStock'
import { useSyncStatus } from '../hooks/useSync'
import { openExternalSafe } from '../lib/open-external'
import { merchantStoreUrl } from '../lib/shop-url'
import { resolveShopIdentity, resolveShopRef } from '../lib/shop-ref'
import { timeAgo } from '../lib/format-time'

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

export function MerchantDetailDialog({
  merchant,
  shopProducts,
  busy,
  refreshingStockId,
  onClose,
  onSyncShop,
  onFavorite,
  onBlock,
  onRefreshStock
}: {
  merchant: Merchant
  shopProducts: ShopProduct[]
  busy: boolean
  refreshingStockId: string | null
  onClose: () => void
  onSyncShop: (m: Merchant) => void
  onFavorite: (m: Merchant) => void
  onBlock: (m: Merchant) => void
  onRefreshStock: (p: ShopProduct) => void
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
        onBlock={onBlock}
        onRefreshStock={onRefreshStock}
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
  onBlock,
  onRefreshStock
}: {
  merchant: Merchant
  shopProducts: ShopProduct[]
  busy: boolean
  refreshingStockId: string | null
  onSyncShop: (m: Merchant) => void
  onFavorite: (m: Merchant) => void
  onBlock: (m: Merchant) => void
  onRefreshStock: (p: ShopProduct) => void
}): React.JSX.Element {
  const dismiss = useModalDismiss()
  const identity = resolveShopIdentity(merchant)
  const [groupFilter, setGroupFilter] = useState<string>('all')
  const groupFilterKey = merchant.id
  const [seenMerchantId, setSeenMerchantId] = useState(groupFilterKey)
  if (groupFilterKey !== seenMerchantId) {
    setSeenMerchantId(groupFilterKey)
    setGroupFilter('all')
  }

  const productGroups = useMemo(() => {
    const counts = new Map<string, number>()
    let ungrouped = 0
    for (const p of shopProducts) {
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
  }, [shopProducts])

  const filteredProducts = useMemo(() => {
    if (groupFilter === 'all') return shopProducts
    if (groupFilter === '__none__') {
      return shopProducts.filter((p) => !productGroupKey(p))
    }
    return shopProducts.filter((p) => productGroupKey(p) === groupFilter)
  }, [shopProducts, groupFilter])

  return (
    <div className="dialog-body">
      <div className="dialog-head">
        <div style={{ minWidth: 0, flex: 1 }}>
          <h2 className="dialog-title" title={merchant.name}>
            {merchant.name}
          </h2>
        </div>
        <IconButton label="关闭" autoFocus onClick={() => dismiss()}>
          <Icon name="close" />
        </IconButton>
      </div>

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

      <div className="row" style={{ marginBottom: 12 }}>
        <Button
          variant="primary"
          onClick={() => void openExternalSafe(merchantStoreUrl(merchant))}
        >
          <Icon name="external" size={14} />
          打开店铺
        </Button>
        {identity.scrapable ? (
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
          variant="ghost"
          onClick={() => onBlock(merchant)}
          title="屏蔽后搜索不再显示该店商品"
        >
          屏蔽
        </Button>
      </div>
      {!identity.scrapable ? (
        <div className="faint small" style={{ marginBottom: 12 }}>
          {identity.reason}。只能打开外链，无法同步店内价。
        </div>
      ) : null}

      <div className="merchant-dialog-products">
        <PanelHeader
          title="店内商品"
          sub={
            shopProducts.length
              ? groupFilter === 'all'
                ? `${shopProducts.length} 条`
                : `${filteredProducts.length}/${shopProducts.length} 条`
              : ''
          }
          style={{ padding: '0 0 8px' }}
        />
        {shopProducts.length && productGroups.length > 0 ? (
          <FilterBar label="分组" style={{ padding: '0 0 10px' }}>
            <Chip on={groupFilter === 'all'} onClick={() => setGroupFilter('all')}>
              全部商品
              <span className="faint"> {shopProducts.length}</span>
            </Chip>
            {productGroups.map((g) => (
              <Chip key={g.key} on={groupFilter === g.key} onClick={() => setGroupFilter(g.key)}>
                {g.label}
                <span className="faint"> {g.count}</span>
              </Chip>
            ))}
          </FilterBar>
        ) : null}
        {!shopProducts.length ? (
          <Empty title="该店尚未同步商品">
            {identity.scrapable
              ? '点上方「同步该店商品」拉取店内价格。'
              : '该店不支持同步店内价。'}
          </Empty>
        ) : !filteredProducts.length ? (
          <Empty title="该分组下无商品">换一个分组，或选「全部商品」。</Empty>
        ) : (
          <div className="merchant-dialog-table-wrap">
            <table className="table detail-products">
              <thead>
                <tr>
                  <th className="col-title">商品</th>
                  <th className="num col-price">价格</th>
                  <th className="num col-stock">库存</th>
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
  )
}

/** 按 merchantId 加载并展示详情弹窗（搜索等页就地打开，不跳转商家页） */
export function MerchantDetailById({
  merchantId,
  onClose
}: {
  merchantId: string
  onClose: () => void
}): React.JSX.Element | null {
  const toast = useToast()
  const { busy, start, status, progress } = useSyncStatus()
  const { refreshingStockId, refreshStock } = useRefreshStock()
  const [merchant, setMerchant] = useState<Merchant | null>(null)
  const [shopProducts, setShopProducts] = useState<ShopProduct[]>([])
  const onCloseRef = useRef(onClose)
  useEffect(() => {
    onCloseRef.current = onClose
  }, [onClose])

  const reload = useCallback(async () => {
    const m = await window.api.merchants.get(merchantId)
    if (!m) {
      setMerchant(null)
      toast('未找到该商家', 'fail')
      onCloseRef.current()
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

  if (!merchant) return null

  return (
    <MerchantDetailDialog
      merchant={merchant}
      shopProducts={shopProducts}
      busy={busy}
      refreshingStockId={refreshingStockId}
      onClose={onClose}
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
      onFavorite={(m) => {
        void window.api.favorites
          .add({ targetType: 'merchant', targetId: m.id })
          .then(() => toast(`已收藏商家：${m.name}`, 'ok'))
      }}
      onBlock={(m) => {
        void window.api.blocklist
          .add({ targetType: 'merchant', targetId: m.id, titleSnapshot: m.name })
          .then(() => {
            toast(`已屏蔽商家：${m.name}（搜索不再显示）`, 'ok')
            onClose()
          })
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
