import type { AppErrorCode } from './errors'

/** Canonical shop scrape job types */
export type ShopSyncJobType = 'shop_one' | 'shop_selected' | 'shop_all'

/** @deprecated aliases accepted at IPC entry; normalized before insert */
export type LegacyLdxpSyncJobType = 'ldxp_shop' | 'ldxp_selected' | 'ldxp_all'

export type SyncJobType =
  | 'merchants'
  | ShopSyncJobType
  | LegacyLdxpSyncJobType
  /** 一键初始化:商家列表 + 报价数 Top N 店铺深刮 */
  | 'bootstrap'

export type SyncJobStatus = 'pending' | 'running' | 'succeeded' | 'partial' | 'failed' | 'cancelled'

export interface SyncProgressEvent {
  jobId: string
  jobType: SyncJobType
  phase: string
  current: number
  total: number
  message?: string
  status: SyncJobStatus
  errorCode?: AppErrorCode
  /** 任务启动时间,渲染层据此估算剩余时间 */
  startedAt?: string
  /** Original job type before alias normalize (e.g. ldxp_all → shop_all) */
  requestedJobType?: SyncJobType
}

/** One outbound HTTP call during an active sync job (UI request stream). */
export type SyncHttpRequestPhase = 'pending' | 'done' | 'error'

export interface SyncHttpRequestEntry {
  id: string
  jobId: string | null
  method: string
  url: string
  host: string
  /** Epoch ms when the request started */
  startedAt: number
  /** Epoch ms when settled; absent while pending */
  endedAt?: number
  /** Final duration ms; UI may compute live from startedAt while pending */
  durationMs?: number
  status?: number | null
  error?: string | null
  /**
   * Outbound path label:
   * - node name when pinned or resolved from mihomo connections
   * - `MA-LB` while load-balancing / unresolved
   * - `直连` when embedded proxy is off
   */
  node: string
  phase: SyncHttpRequestPhase
}

export interface SyncJobRecord {
  id: string
  jobType: SyncJobType
  status: SyncJobStatus
  phase: string | null
  current: number
  total: number
  message: string | null
  errorCode: string | null
  startedAt: string | null
  finishedAt: string | null
  meta: Record<string, unknown> | null
}

export interface SyncStatus {
  running: SyncJobRecord[]
  recent: SyncJobRecord[]
  lastSuccessAt: Partial<Record<SyncJobType, string>>
  counts: {
    merchants: number
    shopProducts: number
    /** Scrapable merchants (shop_platform + shop_token); legacy key name kept for UI */
    ldxpMerchants: number
    scrapableMerchants?: number
  }
}

/** History list filter — `running` means pending+running */
export type SyncHistoryStatusFilter =
  'all' | 'running' | 'succeeded' | 'partial' | 'failed' | 'cancelled'

export interface SyncJobListQuery {
  status?: SyncHistoryStatusFilter
  offset?: number
  limit?: number
}

export interface SyncJobListResult {
  rows: SyncJobRecord[]
  total: number
  offset: number
  limit: number
}

export interface SyncStartRequest {
  jobType: SyncJobType
  merchantId?: string
  token?: string
  /** Platform id for multi-platform shop scrape (required with bare token when not ldxp) */
  platformId?: string
  /** Full shop URL — preferred for manual paste (e.g. https://catfk.com/shop/hththt) */
  shopUrl?: string
  /** for shop_selected / ldxp_selected */
  merchantIds?: string[]
  force?: boolean
  /**
   * 后台自动刷新：不打开系统浏览器过人机；失败后标 failing，不再被自动挑选，
   * 直到用户主动同步成功。
   */
  background?: boolean
}

const JOB_ALIAS: Record<string, SyncJobType> = {
  ldxp_shop: 'shop_one',
  ldxp_selected: 'shop_selected',
  ldxp_all: 'shop_all',
  shop_one: 'shop_one',
  shop_selected: 'shop_selected',
  shop_all: 'shop_all',
  merchants: 'merchants',
  bootstrap: 'bootstrap'
}

/** Canonical job types after alias normalization (no legacy keys). */
export const CANONICAL_JOB_TYPES = [
  'merchants',
  'bootstrap',
  'shop_one',
  'shop_selected',
  'shop_all'
] as const satisfies readonly SyncJobType[]

/**
 * Normalize aliases → canonical before DB insert / lane assignment.
 * Returns null for unknown types so callers can reject before side effects.
 */
export function normalizeJobType(jobType: SyncJobType | string): SyncJobType | null {
  const n = JOB_ALIAS[jobType]
  return n ?? null
}

export function isShopJob(jobType: SyncJobType | string): boolean {
  const n = normalizeJobType(jobType)
  return n === 'shop_one' || n === 'shop_selected' || n === 'shop_all'
}

/**
 * 同步中心「商品同步」：纯店刮任务，或 bootstrap 已进入刮店阶段。
 * 商家列表 / 指纹探测不算商品同步。
 */
export function isProductSyncActivity(
  jobType: SyncJobType | string,
  phase?: string | null
): boolean {
  if (isShopJob(jobType)) return true
  if (jobType !== 'bootstrap') return false
  const p = (phase ?? '').trim()
  if (!p || p === 'starting' || p === 'merchants' || p === 'fingerprint') return false
  return true
}

/** Pairs of aliases that share lastSuccessAt. */
export const JOB_TYPE_ALIAS_GROUPS: readonly (readonly SyncJobType[])[] = [
  ['shop_one', 'ldxp_shop'],
  ['shop_selected', 'ldxp_selected'],
  ['shop_all', 'ldxp_all']
]

export function mergeLastSuccessAt(
  raw: Partial<Record<string, string>>
): Partial<Record<SyncJobType, string>> {
  const out: Partial<Record<SyncJobType, string>> = { ...raw } as Partial<
    Record<SyncJobType, string>
  >
  for (const group of JOB_TYPE_ALIAS_GROUPS) {
    const times = group.map((k) => raw[k]).filter(Boolean) as string[]
    if (!times.length) continue
    const latest = times.sort().at(-1)!
    for (const k of group) out[k] = latest
  }
  return out
}
