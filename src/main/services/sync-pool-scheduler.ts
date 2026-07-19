/**
 * Disabled: product sync uses sequential scrapeShopTarget (simulated browser HTTP).
 * Kept as a stub so accidental imports fail clearly.
 */
import { AppError } from '@shared/types/errors'
import type { ShopScrapeTarget } from '../platforms/registry'
import type { JobPoolSnapshot } from '@shared/types/sync'
import type { NormalizedShopProductRow } from '../db/repositories/shop-products-repo'

export interface PoolSchedulerHooks {
  onProgress: (phase: string, current: number, total: number, message: string) => void
  onSnapshot: (s: JobPoolSnapshot) => void
  setRetrying: (target: ShopScrapeTarget) => void
  commitStore: (args: {
    target: ShopScrapeTarget
    rows: NormalizedShopProductRow[]
    groupErrors: Array<{ groupKey: string; message: string; code?: string; details?: unknown }>
  }) => void
  failStore: (args: {
    target: ShopScrapeTarget
    err: unknown
    label: string
    softMerchant?: boolean
  }) => void
}

export interface PoolSchedulerResult {
  ok: number
  failed: number
  poolMeta?: Record<string, unknown>
}

export async function runShopPool(_opts: {
  jobId: string
  targets: ShopScrapeTarget[]
  signal: AbortSignal
  minIntervalMs: number
  pageConcurrency: number
  background?: boolean
  openSystemBrowserOnWaf?: boolean
  hooks: PoolSchedulerHooks
}): Promise<PoolSchedulerResult> {
  throw new AppError(
    'INTERNAL',
    'runShopPool disabled; product sync uses sequential simulated-browser scrape'
  )
}
