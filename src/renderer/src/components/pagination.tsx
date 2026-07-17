import { useEffect, useState } from 'react'
import { Icon } from './icons'
import { Select } from './select'

/** 0-based page index, or ellipsis sentinel */
export type PaginationItem = number | 'ellipsis'

/**
 * Build page list with edge pages + siblings + ellipsis.
 * `page` / returned numbers are 0-based.
 */
export function getPaginationItems(
  page: number,
  pageCount: number,
  siblingCount = 1
): PaginationItem[] {
  if (pageCount <= 0) return []
  if (pageCount === 1) return [0]

  const totalNumbers = siblingCount * 2 + 5
  if (pageCount <= totalNumbers) {
    return Array.from({ length: pageCount }, (_, i) => i)
  }

  const leftSibling = Math.max(page - siblingCount, 1)
  const rightSibling = Math.min(page + siblingCount, pageCount - 2)
  const showLeftEllipsis = leftSibling > 1
  const showRightEllipsis = rightSibling < pageCount - 2

  if (!showLeftEllipsis && showRightEllipsis) {
    const leftItemCount = 3 + 2 * siblingCount
    return [...Array.from({ length: leftItemCount }, (_, i) => i), 'ellipsis', pageCount - 1]
  }

  if (showLeftEllipsis && !showRightEllipsis) {
    const rightItemCount = 3 + 2 * siblingCount
    return [
      0,
      'ellipsis',
      ...Array.from({ length: rightItemCount }, (_, i) => pageCount - rightItemCount + i)
    ]
  }

  return [
    0,
    'ellipsis',
    ...Array.from({ length: rightSibling - leftSibling + 1 }, (_, i) => leftSibling + i),
    'ellipsis',
    pageCount - 1
  ]
}

export function Pagination({
  page,
  pageCount,
  onChange,
  disabled,
  total,
  pageSize,
  pageSizeOptions,
  onPageSizeChange,
  className
}: {
  /** 0-based current page */
  page: number
  pageCount: number
  onChange: (page: number) => void
  disabled?: boolean
  /** 总条数；提供后显示「共 N 条」与区间 */
  total?: number
  pageSize?: number
  /** 每页条数可选项；与 onPageSizeChange 同时提供时显示切换 */
  pageSizeOptions?: readonly number[]
  onPageSizeChange?: (size: number) => void
  className?: string
}): React.JSX.Element | null {
  const hasTotal = total != null && total > 0
  const hasPages = pageCount > 1
  const hasSize = Boolean(pageSizeOptions?.length && onPageSizeChange && pageSize)

  if (!hasTotal && !hasPages && !hasSize) return null
  if (total != null && total <= 0) return null

  const safeCount = Math.max(1, pageCount)
  const safePage = Math.min(Math.max(0, page), safeCount - 1)
  const items = getPaginationItems(safePage, safeCount)
  const rangeFrom =
    hasTotal && pageSize != null && total! > 0 ? safePage * pageSize + 1 : null
  const rangeTo =
    hasTotal && pageSize != null ? Math.min(total!, (safePage + 1) * pageSize) : null

  const [jumpDraft, setJumpDraft] = useState(String(safePage + 1))
  useEffect(() => {
    setJumpDraft(String(safePage + 1))
  }, [safePage])

  function go(next: number): void {
    if (disabled) return
    const p = Math.min(Math.max(0, next), safeCount - 1)
    if (p !== safePage) onChange(p)
  }

  function commitJump(): void {
    const n = Number.parseInt(jumpDraft.trim(), 10)
    if (!Number.isFinite(n)) {
      setJumpDraft(String(safePage + 1))
      return
    }
    go(n - 1)
    setJumpDraft(String(Math.min(Math.max(1, n), safeCount)))
  }

  const sizeOpts =
    pageSizeOptions?.map((n) => ({
      value: String(n),
      label: `${n} 条/页`
    })) ?? []

  return (
    <nav
      className={['pager', 'pagination', className ?? ''].filter(Boolean).join(' ')}
      aria-label="分页"
    >
      <div className="pagination-meta small muted">
        {hasTotal ? (
          <span>
            共 <span className="num">{total}</span> 条
            {rangeFrom != null && rangeTo != null ? (
              <>
                <span className="sep"> · </span>
                <span className="num">{rangeFrom}</span>–<span className="num">{rangeTo}</span>
              </>
            ) : null}
          </span>
        ) : (
          <span>
            第 <span className="num">{safePage + 1}</span> / <span className="num">{safeCount}</span>{' '}
            页
          </span>
        )}
      </div>

      <div className="pagination-end">
        {hasSize ? (
          <Select
            ariaLabel="每页条数"
            value={String(pageSize)}
            options={sizeOpts}
            disabled={disabled}
            onValueChange={(v) => onPageSizeChange?.(Number(v))}
            className="pagination-size"
          />
        ) : null}

        <div className="pagination-controls" role="group">
          <button
            type="button"
            className="pagination-btn"
            disabled={disabled || safePage <= 0}
            aria-label="首页"
            title="首页"
            onClick={() => go(0)}
          >
            <Icon name="chevronFirst" size={14} />
          </button>
          <button
            type="button"
            className="pagination-btn"
            disabled={disabled || safePage <= 0}
            aria-label="上一页"
            title="上一页"
            onClick={() => go(safePage - 1)}
          >
            <Icon name="chevronLeft" size={14} />
          </button>
          {items.map((item, i) =>
            item === 'ellipsis' ? (
              <span key={`e-${i}`} className="pagination-ellipsis" aria-hidden="true">
                …
              </span>
            ) : (
              <button
                key={item}
                type="button"
                className={`pagination-btn${item === safePage ? ' is-active' : ''}`}
                disabled={disabled}
                aria-label={`第 ${item + 1} 页`}
                aria-current={item === safePage ? 'page' : undefined}
                onClick={() => go(item)}
              >
                {item + 1}
              </button>
            )
          )}
          <button
            type="button"
            className="pagination-btn"
            disabled={disabled || safePage + 1 >= safeCount}
            aria-label="下一页"
            title="下一页"
            onClick={() => go(safePage + 1)}
          >
            <Icon name="chevronRight" size={14} />
          </button>
          <button
            type="button"
            className="pagination-btn"
            disabled={disabled || safePage + 1 >= safeCount}
            aria-label="末页"
            title="末页"
            onClick={() => go(safeCount - 1)}
          >
            <Icon name="chevronLast" size={14} />
          </button>
        </div>

        {safeCount > 1 ? (
          <label className="pagination-jump small muted">
            前往
            <input
              className="pagination-jump-input"
              type="text"
              inputMode="numeric"
              disabled={disabled}
              value={jumpDraft}
              aria-label="页码"
              onChange={(e) => setJumpDraft(e.target.value.replace(/[^\d]/g, ''))}
              onBlur={() => commitJump()}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault()
                  commitJump()
                  ;(e.target as HTMLInputElement).blur()
                }
              }}
            />
            页
          </label>
        ) : null}
      </div>
    </nav>
  )
}
