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
  | 'all'
  | 'running'
  | 'succeeded'
  | 'partial'
  | 'failed'
  | 'cancelled'

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

/** Normalize aliases → canonical before DB insert / lane assignment. */
export function normalizeJobType(jobType: SyncJobType | string): SyncJobType {
  return (JOB_ALIAS[jobType] ?? jobType) as SyncJobType
}

export function isShopJob(jobType: SyncJobType | string): boolean {
  const n = normalizeJobType(jobType)
  return n === 'shop_one' || n === 'shop_selected' || n === 'shop_all'
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
