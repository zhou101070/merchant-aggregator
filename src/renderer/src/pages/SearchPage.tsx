import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link, useLocation, useSearchParams } from 'react-router-dom'
import { SEARCH_DEFAULTS } from '@shared/constants'
import { pushRecentSearch } from '@shared/lib/recent-searches'
import { defaultName, pushSavedSearch, removeSavedSearch } from '@shared/lib/saved-searches'
import type { SavedSearch } from '@shared/types/saved-search'
import type { SearchHit, SearchQuery } from '@shared/types/search'
import { normalizeWordList } from '@shared/types/settings'
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
  SkeletonRows
} from '../components/ui'
import { FilterBar } from '../components/layout'
import { HealthStatus } from '../components/health-status'
import { Pagination } from '../components/pagination'
import { CopyLinkButton } from '../components/copy-link-button'
import { MerchantDetailById } from '../components/merchant-detail-dialog'
import { Icon } from '../components/icons'
import { useConfirm } from '../components/use-confirm'
import { useToast } from '../components/use-toast'
import { useDebouncedValue } from '../hooks/useDebouncedValue'
import { useRefreshStock } from '../hooks/useRefreshStock'
import { useSyncStatus } from '../hooks/useSync'
import { useSyncTerminalTick } from '../hooks/useSyncTerminalTick'
import { bootstrapSpec } from '../lib/confirm-sync'
import { highlightText } from '../lib/highlight'
import { openExternalSafe } from '../lib/open-external'
import { isStale, timeAgo } from '../lib/format-time'
import { searchHotkeyLabel } from '../lib/mod-key'
import { resolveShopRef } from '../lib/shop-ref'

const SPEC_CHIPS = ['质保', '直登', '成品', 'Pro', 'Plus', '邮箱', 'Claude', 'GPT']
const EXCLUDE_SUGGEST = ['共享', '合租', '拼车', '出租']
const PAGE_SIZE_OPTIONS = [50, 100, 200] as const
const DEFAULT_PAGE_SIZE = 100

function parsePriceInput(raw: string): number | undefined {
  const t = raw.trim()
  if (!t) return undefined
  const n = Number(t)
  return Number.isFinite(n) && n >= 0 ? n : undefined
}

type SortKey = NonNullable<SearchQuery['sort']>
type SortDir = NonNullable<SearchQuery['sortDir']>

/** 首次点某列时的默认方向 */
function defaultDirFor(key: SortKey): SortDir {
  if (key === 'price' || key === 'stock' || key === 'title' || key === 'merchant') return 'asc'
  if (key === 'fetchedAt') return 'desc'
  return 'desc'
}

function SortTh({
  label,
  col,
  sort,
  sortDir,
  onSort,
  className
}: {
  label: string
  col: SortKey
  sort: SortKey
  sortDir: SortDir
  onSort: (col: SortKey) => void
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
  const { start, startBootstrap, startMerchants, startShopSelected, busy, status, progress } =
    useSyncStatus()
  const confirm = useConfirm()
  const toast = useToast()
  const { refreshingStockId, refreshStock } = useRefreshStock()
  const location = useLocation()
  const [searchParams] = useSearchParams()
  const [q, setQ] = useState(() => searchParams.get('q') ?? '')
  const [debounced, setDebounced] = useDebouncedValue(
    q.trim(),
    250
  )
  // URL ?q= 变化时(收藏页「按标题搜」等深链)渲染期比较并接管输入
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

  const [merchantName, setMerchantName] = useState<string | undefined>()
  const [titleContains, setTitleContains] = useState<string[]>([])
  const [titleExcludes, setTitleExcludes] = useState<string[]>([])
  const [excludeDraft, setExcludeDraft] = useState('')
  const [priceMinText, setPriceMinText] = useState('')
  const [priceMaxText, setPriceMaxText] = useState('')
  const [sort, setSort] = useState<SortKey>('score')
  const [sortDir, setSortDir] = useState<SortDir>('desc')
  const [facets, setFacets] = useState<Record<string, { value: string; count: number }[]>>({})
  const [loading, setLoading] = useState(false)
  const [page, setPage] = useState(0)
  const [pageSize, setPageSize] = useState(DEFAULT_PAGE_SIZE)
  const [candidatesFor, setCandidatesFor] = useState<{
    key: string
    data: MerchantCandidates
  } | null>(null)
  const [freshHours, setFreshHours] = useState(24)
  const [recentSearches, setRecentSearches] = useState<string[]>([])
  const [savedSearches, setSavedSearches] = useState<SavedSearch[]>([])
  const [selectedIdx, setSelectedIdx] = useState(-1)
  const [detailMerchantId, setDetailMerchantId] = useState<string | null>(null)
  const searchSeq = useRef(0)
  const lastRecordedQ = useRef('')

  const merchants = status?.counts.merchants ?? 0
  // min>max 时交换，避免静默空结果
  const priceMinRaw = parsePriceInput(priceMinText)
  const priceMaxRaw = parsePriceInput(priceMaxText)
  const priceRangeSwapped = priceMinRaw != null && priceMaxRaw != null && priceMinRaw > priceMaxRaw
  const priceMin = priceRangeSwapped ? priceMaxRaw : priceMinRaw
  const priceMax = priceRangeSwapped ? priceMinRaw : priceMaxRaw
  const highlightQuery = useMemo(
    () => [debounced, ...titleContains].filter(Boolean).join(' '),
    [debounced, titleContains]
  )

  useEffect(() => {
    void window.api.settings.get().then((s) => {
      setFreshHours(s.shopFreshHours || 24)
      setRecentSearches(s.recentSearches ?? [])
      setSavedSearches(s.savedSearches ?? [])
      setTitleExcludes(normalizeWordList(s.searchExcludeWords ?? []))
    })
  }, [])

  // 有效搜索词写入最近历史（读最新 settings，避免并发丢词）
  useEffect(() => {
    if (!debounced || debounced === lastRecordedQ.current) return
    lastRecordedQ.current = debounced
    void window.api.settings.get().then((s) => {
      const next = pushRecentSearch(s.recentSearches, debounced)
      setRecentSearches(next)
      return window.api.settings.set({ recentSearches: next })
    })
  }, [debounced])

  const doSearch = useCallback(
    async (offset: number) => {
      const seq = ++searchSeq.current
      setLoading(true)
      try {
        const res = await window.api.search.query({
          q: debounced,
          priceMin,
          priceMax,
          merchantName,
          titleContains: titleContains.length ? titleContains : undefined,
          titleExcludes: titleExcludes.length ? titleExcludes : undefined,
          sort,
          sortDir,
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
    [
      debounced,
      priceMin,
      priceMax,
      merchantName,
      titleContains,
      titleExcludes,
      sort,
      sortDir,
      pageSize
    ]
  )

  // 任何同步任务落定后重搜(新鲜度/新店数据即时反映)
  const syncTick = useSyncTerminalTick(progress)

  // 筛选/pageSize 变化时先回第 0 页再搜，避免用旧 page 打错 offset
  const filterKey = `${debounced}\0${priceMin ?? ''}\0${priceMax ?? ''}\0${merchantName ?? ''}\0${titleContains.join('\0')}\0${titleExcludes.join('\0')}\0${sort}\0${sortDir}\0${pageSize}`
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

  /** 无关键词/规格/店名/价格/排除筛选；有商品时应浏览列表，仅在无命中时才用起始态 */
  const isBrowseIdle =
    !debounced &&
    !titleContains.length &&
    !titleExcludes.length &&
    !merchantName &&
    priceMin == null &&
    priceMax == null
  const showStart = isBrowseIdle && !emptyReason && !loading && hits.length === 0

  const openHit = useCallback(async (hit: SearchHit): Promise<void> => {
    await window.api.recent.touch({
      targetType: hit.kind,
      targetId: hit.id,
      titleSnapshot: hit.title
    })
    await openExternalSafe(hit.sourceUrl)
  }, [])

  // 键盘流：↑↓ 选行，Enter 打开源站，Esc 取消选择
  // KeepAlive 会保留本页挂载；必须按路由与可编辑焦点门控，避免其它页误触 openHit。
  useEffect(() => {
    if (location.pathname !== '/') return
    const onKey = (e: KeyboardEvent): void => {
      const el = e.target
      if (el instanceof HTMLElement) {
        const tag = el.tagName
        const inEditable =
          tag === 'INPUT' ||
          tag === 'TEXTAREA' ||
          tag === 'SELECT' ||
          el.isContentEditable
        if (inEditable && e.key !== 'Escape') return
      }
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
        setSelectedIdx(-1)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [hits, selectedIdx, openHit, location.pathname])

  useEffect(() => {
    if (selectedIdx < 0) return
    document.querySelector('[data-row-selected="true"]')?.scrollIntoView({ block: 'nearest' })
  }, [selectedIdx])

  // 当前结果页内最低价标记
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

  function applySaved(s: SavedSearch): void {
    setQ(s.q)
    setDebounced(s.q.trim())
    setTitleContains([...s.titleContains])
    setTitleExcludes([...s.titleExcludes])
    setPriceMinText(s.priceMin != null ? String(s.priceMin) : '')
    setPriceMaxText(s.priceMax != null ? String(s.priceMax) : '')
    setMerchantName(s.merchantName)
    setSort(s.sort)
    setSortDir(s.sortDir)
    setPage(0)
  }

  async function saveCurrentSearch(): Promise<void> {
    const snap = {
      q: debounced,
      titleContains: [...titleContains],
      titleExcludes: [...titleExcludes],
      inStockOnly: true,
      priceMin,
      priceMax,
      merchantName,
      sort,
      sortDir
    }
    const hasSignal =
      Boolean(snap.q) ||
      snap.titleContains.length > 0 ||
      snap.titleExcludes.length > 0 ||
      snap.priceMin != null ||
      snap.priceMax != null ||
      Boolean(snap.merchantName)
    if (!hasSignal) {
      toast('请先输入关键词或筛选条件再保存', 'fail')
      return
    }
    const name = defaultName(snap)
    const s = await window.api.settings.get()
    const next = pushSavedSearch(s.savedSearches, snap, name)
    await window.api.settings.set({ savedSearches: next })
    setSavedSearches(next)
    toast(`已保存：${name}`, 'ok')
  }

  async function deleteSaved(id: string): Promise<void> {
    const s = await window.api.settings.get()
    const next = removeSavedSearch(s.savedSearches, id)
    await window.api.settings.set({ savedSearches: next })
    setSavedSearches(next)
    toast('已删除常用搜索', 'ok')
  }

  function refreshShop(hit: SearchHit): void {
    const ref = resolveShopRef({
      platformId: hit.platformId,
      shopToken: hit.shopToken,
      ldxpToken: hit.ldxpToken,
      strictPlatform: true
    })
    if (!ref) {
      toast('缺少平台信息，无法刷新该店', 'fail')
      return
    }
    // D20: shop_one + platformId + token — never item sourceUrl as shopUrl
    void start('shop_one', {
      merchantId: hit.merchantId ?? undefined,
      platformId: ref.platformId,
      token: ref.token
    })
    toast(`正在刷新店铺：${hit.merchantName ?? ref.token}，完成后自动重搜`)
  }

  function refreshHitStock(hit: SearchHit): void {
    if (hit.kind !== 'shop_product' || !hit.platformId || !hit.shopGoodsKey) {
      toast('缺少商品信息，无法刷新库存', 'fail')
      return
    }
    void refreshStock(hit.id, {
      onUpdated: (res) =>
        setHits((prev) =>
          prev.map((h) =>
            h.id === hit.id
              ? {
                  ...h,
                  stockCount: res.stock,
                  price: res.product.price,
                  fetchedAt: res.product.fetchedAt,
                  status: 'in_stock'
                }
              : h
          )
        ),
      onRemoved: () => {
        setHits((prev) => prev.filter((h) => h.id !== hit.id))
        setTotal((t) => Math.max(0, t - 1))
      }
    })
  }

  function toggleChip(chip: string): void {
    setTitleContains((prev) =>
      prev.includes(chip) ? prev.filter((c) => c !== chip) : [...prev, chip]
    )
  }

  function setSortKey(key: SortKey): void {
    if (key === sort) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'))
    } else {
      setSort(key)
      setSortDir(defaultDirFor(key))
    }
  }

  /** 顶栏「相关度」：从列排序恢复默认相关度 */
  function restoreScoreSort(): void {
    setSort('score')
    setSortDir(defaultDirFor('score'))
  }

  function persistExcludes(next: string[]): void {
    const normalized = normalizeWordList(next)
    setTitleExcludes(normalized)
    void window.api.settings.set({ searchExcludeWords: normalized })
  }

  function addExclude(term: string): void {
    const t = term.trim()
    if (!t) return
    setExcludeDraft('')
    persistExcludes([...titleExcludes, t])
  }

  function removeExclude(term: string): void {
    persistExcludes(titleExcludes.filter((c) => c !== term))
  }

  function syncCandidates(ids: string[]): void {
    void startShopSelected(ids)
    toast('已开始同步候选店铺，完成后自动重搜')
  }

  async function bootstrap(): Promise<void> {
    if (!(await confirm(bootstrapSpec()))) return
    void startBootstrap()
  }

  const notSynced = emptyReason === 'SHOP_PRODUCTS_NOT_SYNCED'

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
          {sort !== 'score' ? (
            <Button
              variant="ghost"
              size="s"
              onClick={restoreScoreSort}
              title="从列排序恢复为相关度"
            >
              相关度
            </Button>
          ) : null}
          <div
            className="price-range"
            title={`价格区间（元）；默认隐藏 ≤${SEARCH_DEFAULTS.hidePriceAtOrBelow} 与 ≥${SEARCH_DEFAULTS.hidePriceAtOrAbove} 的价`}
          >
            <span className="lab">¥</span>
            <Input
              className="price-input"
              type="number"
              min={0}
              step="0.01"
              placeholder="最低"
              aria-label="最低价"
              value={priceMinText}
              onChange={(e) => setPriceMinText(e.target.value)}
            />
            <span className="muted">–</span>
            <Input
              className="price-input"
              type="number"
              min={0}
              step="0.01"
              placeholder="最高"
              aria-label="最高价"
              value={priceMaxText}
              onChange={(e) => setPriceMaxText(e.target.value)}
            />
          </div>
          <Button
            variant="ghost"
            size="s"
            onClick={() => void saveCurrentSearch()}
            title="保存当前关键词与筛选为常用搜索"
          >
            保存当前
          </Button>
          <IconButton label="导出 CSV" onClick={exportCsv} disabled={!hits.length}>
            <Icon name="download" />
          </IconButton>
        </div>
      </div>

      {savedSearches.length > 0 ? (
        <FilterBar label="常用">
          {savedSearches.map((s) => (
            <span key={s.id} className="chip-with-x">
              <Chip
                on={false}
                onClick={() => applySaved(s)}
                title={[s.q, ...s.titleContains, s.merchantName].filter(Boolean).join(' · ')}
              >
                {s.name}
              </Chip>
              <button
                type="button"
                className="chip-x"
                aria-label={`删除 ${s.name}`}
                onClick={(e) => {
                  e.stopPropagation()
                  void deleteSaved(s.id)
                }}
              >
                ×
              </button>
            </span>
          ))}
        </FilterBar>
      ) : null}

      {recentSearches.length > 0 ? (
        <FilterBar label="最近">
          {recentSearches.slice(0, 8).map((term) => (
            <Chip
              key={term}
              on={debounced === term}
              onClick={() => {
                setQ(term)
                setDebounced(term)
              }}
            >
              {term}
            </Chip>
          ))}
          <button
            type="button"
            className="linkish"
            onClick={() => {
              lastRecordedQ.current = ''
              setRecentSearches([])
              void window.api.settings.set({ recentSearches: [] })
            }}
          >
            清除
          </button>
        </FilterBar>
      ) : null}

      <FilterBar label="规格">
        {SPEC_CHIPS.map((chip) => (
          <Chip key={chip} on={titleContains.includes(chip)} onClick={() => toggleChip(chip)}>
            {chip}
          </Chip>
        ))}
      </FilterBar>

      <FilterBar label="排除">
        {titleExcludes.map((term) => (
          <Chip key={term} on onClick={() => removeExclude(term)}>
            {term}
            <Icon name="close" size={14} />
          </Chip>
        ))}
        {EXCLUDE_SUGGEST.filter((s) => !titleExcludes.includes(s)).map((s) => (
          <Chip key={`sug-${s}`} onClick={() => addExclude(s)}>
            +{s}
          </Chip>
        ))}
        <Input
          className="exclude-input"
          placeholder="排除词 ↵（已保存）"
          aria-label="自定义排除词（持久保存）"
          value={excludeDraft}
          onChange={(e) => setExcludeDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              addExclude(excludeDraft)
            }
          }}
        />
      </FilterBar>

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
            完成后即可直接搜货。
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
          <Empty title="没有匹配结果">
            换个关键词，或按推荐同步可能有货的店。结果默认隐藏 ≤{SEARCH_DEFAULTS.hidePriceAtOrBelow}{' '}
            与 ≥{SEARCH_DEFAULTS.hidePriceAtOrAbove} 的价。
          </Empty>
          {candidates ? (
            <div style={{ padding: '0 24px 28px' }}>
              <CandidatesCta candidates={candidates} busy={busy} onSync={syncCandidates} />
            </div>
          ) : null}
        </div>
      ) : (
        <>
          {(facets.merchant ?? []).length > 0 || merchantName ? (
            <FilterBar label="店铺">
              {merchantName && !(facets.merchant ?? []).some((m) => m.value === merchantName) ? (
                <Chip on onClick={() => setMerchantName(undefined)}>
                  {merchantName}
                  <Icon name="close" size={14} />
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
            </FilterBar>
          ) : null}

          <div className="panel">
            {loading && !hits.length ? (
              <SkeletonRows rows={7} />
            ) : (
              <div className="search-scroll">
                <table className="table">
                  <thead>
                    <tr>
                      <SortTh
                        label="商品"
                        col="title"
                        sort={sort}
                        sortDir={sortDir}
                        onSort={setSortKey}
                      />
                      <SortTh
                        label="价格"
                        col="price"
                        sort={sort}
                        sortDir={sortDir}
                        onSort={setSortKey}
                        className="num"
                      />
                      <SortTh
                        label="店铺"
                        col="merchant"
                        sort={sort}
                        sortDir={sortDir}
                        onSort={setSortKey}
                      />
                      <SortTh
                        label="库存"
                        col="stock"
                        sort={sort}
                        sortDir={sortDir}
                        onSort={setSortKey}
                        className="num"
                      />
                      <SortTh
                        label="更新"
                        col="fetchedAt"
                        sort={sort}
                        sortDir={sortDir}
                        onSort={setSortKey}
                      />
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
                            <HealthStatus health={hit.merchantHealth} />
                          </td>
                          <td className="num mono">{hit.stockCount ?? '—'}</td>
                          <td className="nowrap">
                            <span
                              className={`small ${stale ? 'warn-text' : 'muted'}`}
                              title={hit.fetchedAt ?? undefined}
                            >
                              {timeAgo(hit.fetchedAt)}
                            </span>
                            {stale &&
                            resolveShopRef({
                              platformId: hit.platformId,
                              shopToken: hit.shopToken,
                              ldxpToken: hit.ldxpToken,
                              strictPlatform: true
                            }) ? (
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
                                variant="primary"
                                size="s"
                                onClick={(e) => {
                                  e.stopPropagation()
                                  void openHit(hit)
                                }}
                              >
                                打开源站
                              </Button>
                              {hit.merchantId ? (
                                <button
                                  type="button"
                                  className="linkish"
                                  title="打开商家详情"
                                  onClick={(e) => {
                                    e.stopPropagation()
                                    setDetailMerchantId(hit.merchantId!)
                                  }}
                                >
                                  店铺
                                </button>
                              ) : null}
                              {hit.kind === 'shop_product' && hit.platformId && hit.shopGoodsKey ? (
                                <button
                                  className="linkish"
                                  disabled={refreshingStockId === hit.id}
                                  title="按商品刷新库存（非整店）"
                                  onClick={(e) => {
                                    e.stopPropagation()
                                    refreshHitStock(hit)
                                  }}
                                >
                                  {refreshingStockId === hit.id ? '刷新中…' : '刷新库存'}
                                </button>
                              ) : null}
                              <button
                                className="linkish"
                                onClick={(e) => {
                                  e.stopPropagation()
                                  void favorite(hit)
                                }}
                              >
                                收藏
                              </button>
                              {hit.sourceUrl ? (
                                <CopyLinkButton url={hit.sourceUrl} stopPropagation />
                              ) : null}
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

      {detailMerchantId ? (
        <MerchantDetailById
          merchantId={detailMerchantId}
          onClose={() => setDetailMerchantId(null)}
        />
      ) : null}
    </div>
  )
}
