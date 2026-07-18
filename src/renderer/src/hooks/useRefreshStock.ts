import { useCallback, useRef, useState } from 'react'
import type { RefreshStockResult } from '@shared/types/product'
import { useToast } from '../components/use-toast'

export type RefreshStockHandlers = {
  onUpdated?: (res: Extract<RefreshStockResult, { status: 'updated' }>) => void
  onRemoved?: (res: Extract<RefreshStockResult, { status: 'removed' }>) => void
}

/** 单商品刷新库存：共享 toast 与 in-flight 门控，调用方自行改列表状态。 */
export function useRefreshStock(): {
  refreshingStockId: string | null
  refreshStock: (
    productId: string,
    handlers?: RefreshStockHandlers
  ) => Promise<RefreshStockResult | null>
} {
  const toast = useToast()
  const [refreshingStockId, setRefreshingStockId] = useState<string | null>(null)
  const busyRef = useRef(false)

  const refreshStock = useCallback(
    async (
      productId: string,
      handlers?: RefreshStockHandlers
    ): Promise<RefreshStockResult | null> => {
      if (busyRef.current) return null
      busyRef.current = true
      setRefreshingStockId(productId)
      try {
        const res = await window.api.products.refreshStock({ productId })
        if (res.status === 'updated') {
          handlers?.onUpdated?.(res)
          toast(`库存已更新：${res.stock}`, 'ok')
        } else if (res.status === 'removed') {
          handlers?.onRemoved?.(res)
          toast('库存为 0，已从本地移除', 'ok')
        } else {
          toast('未在店内找到该商品（标题可能已变更）', 'fail')
        }
        return res
      } catch (err) {
        toast(err instanceof Error ? err.message : String(err), 'fail')
        return null
      } finally {
        busyRef.current = false
        setRefreshingStockId(null)
      }
    },
    [toast]
  )

  return { refreshingStockId, refreshStock }
}
