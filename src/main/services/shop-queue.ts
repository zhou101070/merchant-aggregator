/**
 * Host-grouped shop scrape queue helpers.
 *
 * Live product sync groups targets by domain (host key), runs up to
 * maxHostParallel host groups in parallel, and processes shops within
 * each host sequentially so same-host work does not waste global slots.
 */
import { scrapeTargetHostKey, type ShopScrapeTarget } from '../platforms/registry'
import { mapWithConcurrency } from './rate-limiter'

export interface HostTargetGroup {
  host: string
  targets: ShopScrapeTarget[]
}

/**
 * Group scrape targets by host key (stable: first-seen host order;
 * within a group, input relative order is preserved).
 */
export function groupShopTargetsByHost(
  targets: readonly ShopScrapeTarget[]
): HostTargetGroup[] {
  const order: string[] = []
  const map = new Map<string, ShopScrapeTarget[]>()
  for (const t of targets) {
    const host = scrapeTargetHostKey(t)
    let bucket = map.get(host)
    if (!bucket) {
      order.push(host)
      bucket = []
      map.set(host, bucket)
    }
    bucket.push(t)
  }
  return order.map((host) => ({ host, targets: map.get(host)! }))
}

/**
 * Run worker over targets: parallel across hosts (capped by maxHostParallel),
 * sequential within each host group.
 */
export async function runHostGroupedQueue(
  targets: readonly ShopScrapeTarget[],
  maxHostParallel: number,
  worker: (target: ShopScrapeTarget) => Promise<void>,
  signal?: AbortSignal
): Promise<void> {
  const groups = groupShopTargetsByHost(targets)
  if (groups.length === 0) return

  await mapWithConcurrency(
    groups,
    maxHostParallel,
    async (group) => {
      for (const target of group.targets) {
        if (signal?.aborted) {
          const err = new Error('aborted')
          err.name = 'AbortError'
          throw err
        }
        await worker(target)
      }
    },
    signal
  )
}
