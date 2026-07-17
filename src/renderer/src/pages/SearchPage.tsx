import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import type { SearchHit } from '@shared/types/search'
import type { MerchantCandidates } from '@shared/types/merchant'
import {
  Button,
  Chip,
  Empty,
  IconButton,
  Input,
  Kbd,
  LowFlag,
  Price,
  Segmented,
  SkeletonRows,
  StatusDot
} from '../components/ui'
import { Pagination } from '../components/pagination'
import { Icon } from '../components/icons'
import { useConfirm } from '../components/use-confirm'
import { useToast } from '../components/use-toast'
import { useSyncStatus } from '../hooks/useSync'
import { bootstrapSpec } from '../lib/confirm-sync'
import { highlightText } from '../lib/highlight'
import { openExternalSafe } from '../lib/open-external'
import { isStale, timeAgo } from '../lib/format-time'
import { searchHotkeyLabel } from '../lib/mod-key'

const SPEC_CHIPS = ['质保', '直登', '成品', 'Pro', 'Plus', '邮箱', 'Claude', 'GPT']
const PAGE_SIZE_OPTIONS = [50, 100, 200] as const
const DEFAULT_PAGE_SIZE = 100

function healthTone(h: string | null | undefined): 'ok' | 'fail' | 'warn' | 'default' {
  if (h === 'healthy') return 'ok'
  if (h === 'failing') return 'fail'
  if (h === 'retrying' || h === 'never') return 'warn'
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
    default:
      return h?.trim() ? h : '未同步'
  }
}

/** 待同步候选店 CTA：搜索无数据/无命中时，引导按意图补数据 */
function CandidatesCta({
  candidates,
  busy,
  onSync
}: {
  candidates: MerchantCandidates | null
  busy: boolean
  onSync: (ids: string[]) => void
}): React.JSX.Element | null {
  if (!candidates) return null
  if (candidates.merchantIds.length > 0) {
    return (
      <div className="stack" style={{ alignItems: 'center', gap: 10 }}>
        <div className="muted small">
          按关键词匹配到 {candidates.totalMatching} 家可能有货的店，其中{' '}
          {candidates.merchantIds.length} 家待同步：{candidates.sample.join('、')}
          {candidates.totalMatching > candidates.sample.length ? ' 等' : ''}
        </div>
        <Button variant="primary" disabled={busy} onClick={() => onSync(candidates.merchantIds)}>
          同步这 {candidates.merchantIds.length} 家店，完成后自动重搜
        </Button>
      </div>
    )
  }
  if (candidates.totalMatching > 0) {
    return (
      <div className="muted small">
        相关的 {candidates.totalMatching} 家店都已在新鲜期内，本地数据已是最新 —— 试试换个关键词。
      </div>
    )
  }
  return null
}

export function SearchPage(): React.JSX.Element {
  const { start, startBootstrap, startMerchants, startLdxpSelected, busy, status, progress } =
    useSyncStatus()
  const confirm = useConfirm()
  const toast = useToast()
  const [searchParams] = useSearchParams()
  const [q, setQ] = useState(() => searchParams.get('q') ?? '')
  const [debounced, setDebounced] = useState(() => (searchParams.get('q') ?? '').trim())
  // URL ?q= 变化时(收藏页"去比价"等深链)渲染期比较并接管输入
  const urlQ = searchParams.get('q')
  const [seenUrlQ, setSeenUrlQ] = useState(urlQ)
  if (urlQ !== seenUrlQ) {
    setSeenUrlQ(urlQ)
    if (urlQ != null) {
      setQ(urlQ)
      setDebounced(urlQ.trim())
    }
  }
  const [hits, setHits] = useState<SearchHit[]>([])
  const [total, setTotal] = useState(0)
  const [emptyReason, setEmptyReason] = useState<string | undefined>()
  const [inStockOnly, setInStockOnly] = useState(false)
  const [merchantName, setMerchantName] = useState<string | undefined>()
  const [titleContains, setTitleContains] = useState<string[]>([])
  const [sort, setSort] = useState<'score' | 'price'>('score')
  const [facets, setFacets] = useState<Record<string, { value: string; count: number }[]>>({})
  const [compareRows, setCompareRows] = useState<SearchHit[] | null>(null)
  const [compareTitle, setCompareTitle] = useState('')
  const [compareNotice, setCompareNotice] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [page, setPage] = useState(0)
  const [pageSize, setPageSize] = useState(DEFAULT_PAGE_SIZE)
  const [candidatesFor, setCandidatesFor] = useState<{
    key: string
    data: MerchantCandidates
  } | null>(null)
  const [freshHours, setFreshHours] = useState(24)
  const [selectedIdx, setSelectedIdx] = useState(-1)
  const searchSeq = useRef(0)

  const merchants = status?.counts.merchants ?? 0

  const highlightQuery = useMemo(
    () => [debounced, ...titleContains].filter(Boolean).join(' '),
    [debounced, titleContains]
  )

  useEffect(() => {
    void window.api.settings.get().then((s) => setFreshHours(s.shopFreshHours || 24))
  }, [])

  useEffect(() => {
    const t = setTimeout(() => setDebounced(q.trim()), 250)
    return () => clearTimeout(t)
  }, [q])

  const doSearch = useCallback(
    async (offset: number) => {
      const seq = ++searchSeq.current
      setLoading(true)
      try {
        const res = await window.api.search.query({
          q: debounced,
          inStockOnly: inStockOnly || undefined,
          merchantName,
          titleContains: titleContains.length ? titleContains : undefined,
          sort,
          sortDir: sort === 'price' ? 'asc' : 'desc',
          limit: pageSize,
          offset
        })
        if (seq !== searchSeq.current) return
        setTotal(res.total)
        setEmptyReason(res.emptyReason)
        setFacets(res.facets ?? {})
        setHits(res.hits)
        setSelectedIdx(-1)
      } finally {
        if (seq === searchSeq.current) setLoading(false)
      }
    },
    [debounced, inStockOnly, merchantName, titleContains, sort, pageSize]
  )

  // 任何同步任务落定后重搜(新鲜度/新店数据即时反映)
  const syncTick =
    progress && ['succeeded', 'failed', 'partial', 'cancelled'].includes(progress.status)
      ? `${progress.jobId}:${progress.status}`
      : ''

  // 筛选/pageSize 变化时先回第 0 页再搜，避免用旧 page 打错 offset
  const filterKey = `${debounced}\0${inStockOnly}\0${merchantName ?? ''}\0${titleContains.join('\0')}\0${sort}\0${pageSize}`
  const prevFilterKey = useRef(filterKey)
  useEffect(() => {
    const filtersChanged = prevFilterKey.current !== filterKey
    if (filtersChanged) {
      prevFilterKey.current = filterKey
      if (page !== 0) {
        setPage(0)
        return
      }
      void doSearch(0)
      return
    }
    void doSearch(page * pageSize)
  }, [filterKey, page, pageSize, syncTick, doSearch])

  const pageCount = Math.max(1, Math.ceil(total / pageSize) || 1)
  const showPager = total > 0

  // 总数变少时把页码钳回合法范围
  useEffect(() => {
    const maxPage = Math.max(0, Math.ceil(total / pageSize) - 1)
    if (page > maxPage) setPage(maxPage)
  }, [total, page, pageSize])

  // 无数据/无命中时，按关键词找待同步的候选店(按关键词键控，过期结果渲染期丢弃)
  const wantCandidates = Boolean(
    debounced && (emptyReason === 'NO_MATCH' || emptyReason === 'SHOP_PRODUCTS_NOT_SYNCED')
  )
  useEffect(() => {
    if (!wantCandidates) return
    let alive = true
    void window.api.merchants.candidates(debounced).then((c) => {
      if (alive) setCandidatesFor({ key: debounced, data: c })
    })
    return () => {
      alive = false
    }
  }, [wantCandidates, debounced, syncTick])
  const candidates = wantCandidates && candidatesFor?.key === debounced ? candidatesFor.data : null

  /** 无关键词/规格/店名筛选；有商品时应浏览列表，仅在无命中时才用起始态 */
  const isBrowseIdle =
    !debounced && !titleContains.length && !merchantName && !inStockOnly
  const showStart = isBrowseIdle && !emptyReason && !loading && hits.length === 0

  const openHit = useCallback(async (hit: SearchHit): Promise<void> => {
    await window.api.recent.touch({
      targetType: hit.kind,
      targetId: hit.id,
      titleSnapshot: hit.title
    })
    await openExternalSafe(hit.sourceUrl)
  }, [])

  const closeCompare = useCallback((): void => {
    setCompareRows(null)
    setCompareNotice(null)
  }, [])

  // 键盘流：↑↓ 选行，Enter 打开源站，Esc 关抽屉/取消选择
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        if (!hits.length) return
        e.preventDefault()
        setSelectedIdx((i) =>
          e.key === 'ArrowDown' ? Math.min(hits.length - 1, i + 1) : Math.max(0, i - 1)
        )
      } else if (e.key === 'Enter') {
        if (selectedIdx >= 0 && hits[selectedIdx]) {
          e.preventDefault()
          void openHit(hits[selectedIdx])
        }
      } else if (e.key === 'Escape') {
        if (compareRows) closeCompare()
        else setSelectedIdx(-1)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [hits, selectedIdx, openHit, compareRows, closeCompare])

  useEffect(() => {
    if (selectedIdx < 0) return
    document.querySelector('[data-row-selected="true"]')?.scrollIntoView({ block: 'nearest' })
  }, [selectedIdx])

  // 当前结果内最低价：主列表直接完成比价
  const minPrice = useMemo(() => {
    const prices = hits
      .map((h) => h.price)
      .filter((p): p is number => p != null && Number.isFinite(p))
    return prices.length >= 2 ? Math.min(...prices) : null
  }, [hits])

  function exportCsv(): void {
    const header = ['title', 'price', 'currency', 'merchant', 'stock', 'fetchedAt', 'url']
    const lines = [header.join(',')]
    for (const h of hits) {
      lines.push(
        [
          JSON.stringify(h.title),
          h.price ?? '',
          h.currency ?? '',
          JSON.stringify(h.merchantName ?? ''),
          h.stockCount ?? '',
          h.fetchedAt ?? '',
          h.sourceUrl ?? ''
        ].join(',')
      )
    }
    const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = `search-${Date.now()}.csv`
    a.click()
    URL.revokeObjectURL(a.href)
  }

  async function favorite(hit: SearchHit): Promise<void> {
    if (hit.kind === 'shop_product') {
      await window.api.favorites.add({
        targetType: 'shop_product',
        targetId: hit.id.replace(/^shop:/, '')
      })
      toast(`已收藏：${hit.title}`, 'ok')
    }
  }

  async function compare(hit: SearchHit): Promise<void> {
    const res = await window.api.products.compare({ titleNorm: hit.title })
    setCompareTitle(hit.title)
    setCompareNotice(res.notice ?? null)
    setCompareRows(res.rows)
  }

  function refreshShop(hit: SearchHit): void {
    const platformId = hit.platformId ?? undefined
    const token = hit.shopToken ?? hit.ldxpToken ?? undefined
    if (!platformId || !token) {
      toast('缺少平台信息，无法刷新该店', 'fail')
      return
    }
    // D20: shop_one + platformId + token — never item sourceUrl as shopUrl
    void start('shop_one', {
      merchantId: hit.merchantId ?? undefined,
      platformId,
      token
    })
    toast(`正在刷新店铺：${hit.merchantName ?? token}，完成后自动重搜`)
  }

  function toggleChip(chip: string): void {
    setTitleContains((prev) =>
      prev.includes(chip) ? prev.filter((c) => c !== chip) : [...prev, chip]
    )
  }

  function syncCandidates(ids: string[]): void {
    void startLdxpSelected(ids)
    toast('已开始同步候选店铺，完成后自动重搜')
  }

  async function bootstrap(): Promise<void> {
    if (!(await confirm(bootstrapSpec()))) return
    void startBootstrap()
  }

  const notSynced = emptyReason === 'SHOP_PRODUCTS_NOT_SYNCED'
  const compareMin = useMemo(() => {
    if (!compareRows?.length) return null
    const prices = compareRows
      .map((r) => r.price)
      .filter((p): p is number => p != null && Number.isFinite(p))
    return prices.length >= 2 ? Math.min(...prices) : null
  }, [compareRows])

  return (
    <div className="stack" style={{ gap: 14 }}>
      <div className="row between">
        <div className="search-bar">
          <Icon name="search" />
          <Input
            data-search-input
            className="search-input"
            placeholder="搜货：Claude Pro / Outlook / GPT…"
            aria-label="全局搜索"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            autoFocus
          />
          <Kbd>{searchHotkeyLabel()}</Kbd>
        </div>
        <div className="row" style={{ flexWrap: 'nowrap' }}>
          <Segmented
            label="排序"
            value={sort}
            onChange={setSort}
            options={[
              { value: 'score', label: '相关度' },
              { value: 'price', label: '价格 ↑' }
            ]}
          />
          <Chip on={inStockOnly} onClick={() => setInStockOnly((v) => !v)}>
            仅有货
          </Chip>
          <IconButton label="导出 CSV" onClick={exportCsv} disabled={!hits.length}>
            <Icon name="download" />
          </IconButton>
        </div>
      </div>

      <div className="filter-bar">
        <span className="lab">规格</span>
        {SPEC_CHIPS.map((chip) => (
          <Chip key={chip} on={titleContains.includes(chip)} onClick={() => toggleChip(chip)}>
            {chip}
          </Chip>
        ))}
      </div>

      {merchants === 0 ? (
        <div className="panel">
          <Empty
            title="先同步数据，才能开始搜货"
            actions={
              <>
                <Button variant="primary" loading={busy} onClick={() => void bootstrap()}>
                  一键初始化（商家 + Top 50 店铺）
                </Button>
                <Button disabled={busy} onClick={() => void startMerchants()}>
                  只同步商家列表
                </Button>
              </>
            }
          >
            第一次使用：一键初始化会同步商家列表，并抓取最热门 50 家店铺的商品价格，
            完成后即可直接搜货比价。
          </Empty>
        </div>
      ) : notSynced ? (
        <div className="panel">
          <Empty
            title="本地还没有商品价格"
            actions={
              <>
                <Button variant="primary" loading={busy} onClick={() => void bootstrap()}>
                  同步 Top 50 热门店铺
                </Button>
                <Link to="/merchants">
                  <Button>去商家列表挑选</Button>
                </Link>
              </>
            }
          >
            {debounced
              ? '可以按下面的推荐，只同步可能卖这类货的店 —— 比全量快得多。'
              : '先同步店铺商品才能搜价；推荐从热门店铺开始。'}
          </Empty>
          {candidates ? (
            <div style={{ padding: '0 24px 28px' }}>
              <CandidatesCta candidates={candidates} busy={busy} onSync={syncCandidates} />
            </div>
          ) : null}
        </div>
      ) : showStart ? (
        <div className="panel">
          <Empty title="输入关键词开始搜货">
            本地检索已同步的发卡网商品，按 <Kbd>↑</Kbd> <Kbd>↓</Kbd> 选择、<Kbd>Enter</Kbd>{' '}
            打开源站；搜索永不联网。
            <br />
            最近浏览请到侧栏「收藏与最近」。
          </Empty>
        </div>
      ) : emptyReason === 'NO_MATCH' ? (
        <div className="panel">
          <Empty title="没有匹配结果">换个关键词，或按推荐同步可能有货的店。</Empty>
          {candidates ? (
            <div style={{ padding: '0 24px 28px' }}>
              <CandidatesCta candidates={candidates} busy={busy} onSync={syncCandidates} />
            </div>
          ) : null}
        </div>
      ) : (
        <>
          {(facets.merchant ?? []).length > 0 || merchantName ? (
            <div className="filter-bar">
              <span className="lab">店铺</span>
              {merchantName && !(facets.merchant ?? []).some((m) => m.value === merchantName) ? (
                <Chip on onClick={() => setMerchantName(undefined)}>
                  {merchantName}
                  <Icon name="close" size={12} />
                </Chip>
              ) : null}
              {(facets.merchant ?? []).slice(0, 8).map((m) => (
                <Chip
                  key={m.value}
                  on={merchantName === m.value}
                  onClick={() =>
                    setMerchantName((prev) => (prev === m.value ? undefined : m.value))
                  }
                >
                  {m.value}
                  <span className="mono">{m.count}</span>
                </Chip>
              ))}
            </div>
          ) : null}

          <div className="panel">
            {loading && !hits.length ? (
              <SkeletonRows rows={7} />
            ) : (
              <div className="search-scroll">
                <table className="table">
                  <thead>
                    <tr>
                      <th>商品</th>
                      <th className="num">价格</th>
                      <th>店铺</th>
                      <th className="num">库存</th>
                      <th>更新</th>
                      <th></th>
                    </tr>
                  </thead>
                  <tbody>
                    {hits.map((hit, idx) => {
                      const stale = isStale(hit.fetchedAt, freshHours)
                      const isLowest =
                        minPrice != null && hit.price != null && hit.price === minPrice
                      const selected = idx === selectedIdx
                      return (
                        <tr
                          key={hit.id}
                          className={selected ? 'selected' : ''}
                          data-row-selected={selected ? 'true' : undefined}
                          onClick={() => setSelectedIdx(idx)}
                        >
                          <td>
                            <div>{highlightText(hit.title, highlightQuery)}</div>
                          </td>
                          <td className="num">
                            <Price price={hit.price} currency={hit.currency} lowest={isLowest} />
                            {isLowest ? (
                              <div>
                                <LowFlag />
                              </div>
                            ) : null}
                          </td>
                          <td>
                            <div className="ellipsis" style={{ maxWidth: 180 }}>
                              {hit.merchantName ?? '—'}
                            </div>
                            <StatusDot tone={healthTone(hit.merchantHealth)}>
                              {healthLabel(hit.merchantHealth)}
                            </StatusDot>
                          </td>
                          <td className="num mono">{hit.stockCount ?? '—'}</td>
                          <td className="nowrap">
                            <span
                              className={`small ${stale ? 'warn-text' : 'muted'}`}
                              title={hit.fetchedAt ?? undefined}
                            >
                              {timeAgo(hit.fetchedAt)}
                            </span>
                            {stale && (hit.shopToken || hit.ldxpToken) && hit.platformId ? (
                              <div>
                                <button
                                  className="linkish"
                                  disabled={busy}
                                  onClick={(e) => {
                                    e.stopPropagation()
                                    refreshShop(hit)
                                  }}
                                >
                                  刷新该店
                                </button>
                              </div>
                            ) : null}
                          </td>
                          <td>
                            <div className="row-actions">
                              <Button
                                onClick={(e) => {
                                  e.stopPropagation()
                                  void openHit(hit)
                                }}
                              >
                                打开源站
                              </Button>
                              <button
                                className="linkish"
                                onClick={(e) => {
                                  e.stopPropagation()
                                  void compare(hit)
                                }}
                              >
                                比价
                              </button>
                              <button
                                className="linkish"
                                onClick={(e) => {
                                  e.stopPropagation()
                                  void favorite(hit)
                                }}
                              >
                                收藏
                              </button>
                            </div>
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            )}
            {showPager ? (
              <Pagination
                page={page}
                pageCount={pageCount}
                total={total}
                pageSize={pageSize}
                pageSizeOptions={PAGE_SIZE_OPTIONS}
                disabled={loading}
                onChange={setPage}
                onPageSizeChange={setPageSize}
              />
            ) : null}
          </div>
        </>
      )}

      {compareRows ? (
        <>
          <button className="scrim" aria-label="关闭比价" onClick={closeCompare} />
          <aside className="drawer" role="dialog" aria-label="比价">
            <div className="drawer-head">
              <strong title={compareTitle}>比价：{compareTitle}</strong>
              <IconButton label="关闭" onClick={closeCompare}>
                <Icon name="close" />
              </IconButton>
            </div>
            {compareNotice ? <div className="drawer-note">{compareNotice}</div> : null}
            <div className="drawer-body">
              {!compareRows.length ? (
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
                    {compareRows.map((r) => {
                      const lowest = compareMin != null && r.price != null && r.price === compareMin
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
                            <IconButton label="打开源站" onClick={() => void openHit(r)}>
                              <Icon name="external" size={14} />
                            </IconButton>
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
      ) : null}
    </div>
  )
}
