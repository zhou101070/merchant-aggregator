import { useCallback, useEffect, useMemo, useState } from 'react'
import type { SearchHit } from '@shared/types/search'
import { CopyLinkButton } from './copy-link-button'
import { Empty, IconButton, LowFlag, Price } from './ui'
import { Icon } from './icons'
import { openExternalSafe } from '../lib/open-external'

export type CompareDrawerProps = {
  title: string | null
  onClose: () => void
  /** Optional: after open source site (e.g. recent.touch) */
  onOpenHit?: (hit: SearchHit) => void | Promise<void>
}

type CompareState =
  | { status: 'idle' }
  | { status: 'ready'; title: string; rows: SearchHit[]; notice: string | null }

/**
 * Weak title compare drawer shared by Search / Favorites.
 * When `title` is non-null, loads products.compare and shows panel.
 */
export function CompareDrawer({
  title,
  onClose,
  onOpenHit
}: CompareDrawerProps): React.JSX.Element | null {
  const [state, setState] = useState<CompareState>({ status: 'idle' })
  const openKey = title?.trim() || null

  useEffect(() => {
    if (!openKey) return
    let alive = true
    void window.api.products
      .compare({ titleNorm: openKey })
      .then((res) => {
        if (!alive) return
        setState({
          status: 'ready',
          title: openKey,
          rows: res.rows,
          notice: res.notice ?? null
        })
      })
      .catch(() => {
        if (!alive) return
        setState({ status: 'ready', title: openKey, rows: [], notice: null })
      })
    return () => {
      alive = false
    }
  }, [openKey])

  const rows = state.status === 'ready' && state.title === openKey ? state.rows : null
  const notice = state.status === 'ready' && state.title === openKey ? state.notice : null
  const loading = Boolean(openKey) && !(state.status === 'ready' && state.title === openKey)
  const displayTitle = openKey

  const minPrice = useMemo(() => {
    if (!rows?.length) return null
    const prices = rows
      .map((r) => r.price)
      .filter((p): p is number => p != null && Number.isFinite(p))
    return prices.length ? Math.min(...prices) : null
  }, [rows])

  const openHit = useCallback(
    async (hit: SearchHit): Promise<void> => {
      if (onOpenHit) {
        await onOpenHit(hit)
        return
      }
      await openExternalSafe(hit.sourceUrl)
    },
    [onOpenHit]
  )

  useEffect(() => {
    if (!openKey) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault()
        onClose()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [openKey, onClose])

  if (!openKey) return null

  return (
    <>
      <button className="scrim" aria-label="关闭比价" onClick={onClose} />
      <aside className="drawer" role="dialog" aria-label="比价">
        <div className="drawer-head">
          <strong title={openKey}>比价：{displayTitle}</strong>
          <IconButton label="关闭" onClick={onClose}>
            <Icon name="close" />
          </IconButton>
        </div>
        {notice ? <div className="drawer-note">{notice}</div> : null}
        <div className="drawer-body">
          {loading ? (
            <div className="muted">加载比价…</div>
          ) : !rows?.length ? (
            <Empty title="没有足够相似的标题可对比">试试更短的关键词搜索。</Empty>
          ) : (
            <table className="table">
              <thead>
                <tr>
                  <th>商品</th>
                  <th>店铺</th>
                  <th className="num">价格</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const lowest = minPrice != null && r.price != null && r.price === minPrice
                  return (
                    <tr key={r.id}>
                      <td>
                        <div className="ellipsis" style={{ maxWidth: 150 }} title={r.title}>
                          {r.title}
                        </div>
                      </td>
                      <td>
                        <div className="ellipsis" style={{ maxWidth: 100 }}>
                          {r.merchantName ?? '—'}
                        </div>
                      </td>
                      <td className="num">
                        <Price price={r.price} currency={r.currency} lowest={lowest} />
                        {lowest ? (
                          <div>
                            <LowFlag />
                          </div>
                        ) : null}
                      </td>
                      <td>
                        <div className="row-actions" style={{ opacity: 1 }}>
                          <IconButton label="打开源站" onClick={() => void openHit(r)}>
                            <Icon name="external" size={14} />
                          </IconButton>
                          {r.sourceUrl ? <CopyLinkButton url={r.sourceUrl} /> : null}
                        </div>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          )}
        </div>
      </aside>
    </>
  )
}
