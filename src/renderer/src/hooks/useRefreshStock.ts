import { useCallback, useRef, useState } from 'react'
import type { RefreshStockResult } from '@shared/types/product'
import { useToast } from '../components/use-toast'
import { formatUserError } from '../lib/sync-labels'

export type RefreshStockHandlers = {
  onUpdated?: (res: Extract<RefreshStockResult, { status: 'updated' }>) => void
  onRemoved?: (res: Extract<RefreshStockResult, { status: 'removed' }>) => void
}

export type RefreshStockBatchHandlers = {
  /** Called after each product finishes. Errors still invoke with null res. */
  onItem?: (productId: string, res: RefreshStockResult | null) => void
}

export type RefreshStockBatchSummary = {
  total: number
  updated: number
  /** 下架 / 店内未找到并已删本地 */
  removed: number
  failed: number
}

/** 单商品 / 批量刷新库存：共享 toast 与 in-flight 门控，调用方自行改列表状态。 */
export function useRefreshStock(): {
  refreshingStockId: string | null
  /** 批量进行中时为 { current, total }（current 从 1 起，完成一项 +1） */
  batchProgress: { current: number; total: number } | null
  refreshStock: (
    productId: string,
    handlers?: RefreshStockHandlers
  ) => Promise<RefreshStockResult | null>
  refreshStockBatch: (
    productIds: string[],
    handlers?: RefreshStockBatchHandlers
  ) => Promise<RefreshStockBatchSummary | null>
  /** 取消当前正在进行的刷新（单项或批量） */
  cancel: () => void
} {
  const toast = useToast()
  const [refreshingStockId, setRefreshingStockId] = useState<string | null>(null)
  const [batchProgress, setBatchProgress] = useState<{ current: number; total: number } | null>(
    null
  )
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
        } else if (res.status === 'removed' || res.status === 'not_found') {
          // not_found：兼容旧结果；服务端现在找不到会删库并返回 removed
          const removed: Extract<RefreshStockResult, { status: 'removed' }> =
            res.status === 'removed' ? res : { status: 'removed', productId: res.productId, stock: null }
          handlers?.onRemoved?.(removed)
          toast('店内未找到该商品，已从本地移除', 'ok')
        } else {
          toast('刷新库存失败', 'fail')
        }
        return res
      } catch (err) {
        toast(formatUserError(err), 'fail')
        return null
      } finally {
        busyRef.current = false
        setRefreshingStockId(null)
      }
    },
    [toast]
  )

  const refreshStockBatch = useCallback(
    async (
      productIds: string[],
      handlers?: RefreshStockBatchHandlers
    ): Promise<RefreshStockBatchSummary | null> => {
      if (busyRef.current) return null
      const ids = [...new Set(productIds.filter(Boolean))]
      if (ids.length === 0) {
        toast('没有可刷新库存的商品', 'fail')
        return null
      }

      busyRef.current = true
      const summary: RefreshStockBatchSummary = {
        total: ids.length,
        updated: 0,
        removed: 0,
        failed: 0
      }

      try {
        for (let i = 0; i < ids.length; i++) {
          const productId = ids[i]!
          setBatchProgress({ current: i + 1, total: ids.length })
          setRefreshingStockId(productId)
          try {
            const res = await window.api.products.refreshStock({ productId })
            if (res.status === 'updated') summary.updated += 1
            else if (res.status === 'removed' || res.status === 'not_found') summary.removed += 1
            else summary.failed += 1
            // 统一把 not_found 当成 removed 交给 UI（列表删行）
            const forUi: RefreshStockResult =
              res.status === 'not_found'
                ? { status: 'removed', productId: res.productId, stock: null }
                : res
            handlers?.onItem?.(productId, forUi)
          } catch {
            summary.failed += 1
            handlers?.onItem?.(productId, null)
            // 单项失败不打断整批；最后汇总
          }
        }

        const parts: string[] = []
        if (summary.updated) parts.push(`更新 ${summary.updated}`)
        if (summary.removed) parts.push(`移除 ${summary.removed}`)
        if (summary.failed) parts.push(`失败 ${summary.failed}`)
        const tone =
          summary.failed > 0
            ? summary.updated + summary.removed > 0
              ? 'warn'
              : 'fail'
            : 'ok'
        toast(
          parts.length > 0
            ? `库存刷新完成：${parts.join('，')}（共 ${summary.total}）`
            : `库存刷新完成（共 ${summary.total}）`,
          tone
        )
        return summary
      } finally {
        busyRef.current = false
        setRefreshingStockId(null)
        setBatchProgress(null)
      }
    },
    [toast]
  )

  const cancel = useCallback(() => {
    busyRef.current = false
    setRefreshingStockId(null)
    setBatchProgress(null)
  }, [])

  return { refreshingStockId, batchProgress, refreshStock, refreshStockBatch, cancel }
}
