/**
 * Host-grouped shop scrape queue helpers.
 *
 * Live product sync groups targets by domain (host key), runs up to
 * maxHostParallel host groups in parallel, and processes shops within
 * each host sequentially so same-host work does not waste global slots.
 */
import { scrapeTargetHostKey, type ShopScrapeTarget } from '../platforms/registry'
import { mapWithConcurrency } from './rate-limiter'

const hostQueueTails = new Map<string, Promise<void>>()

function abortError(): Error {
  const err = new Error('aborted')
  err.name = 'AbortError'
  return err
}

async function waitForHostTurn(
  host: string,
  signal?: AbortSignal
): Promise<{ release: () => void; ticket: Promise<void> }> {
  const previous = hostQueueTails.get(host) ?? Promise.resolve()
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  // Keep an aborted middle waiter chained behind its predecessor so a later
  // waiter cannot overtake the currently active scrape.
  const ticket = previous.then(() => gate)
  hostQueueTails.set(host, ticket)

  try {
    if (signal?.aborted) throw abortError()
    await new Promise<void>((resolve, reject) => {
      let settled = false
      const onAbort = (): void => {
        if (settled) return
        settled = true
        reject(abortError())
      }
      signal?.addEventListener('abort', onAbort, { once: true })
      previous.then(
        () => {
          if (settled) return
          settled = true
          signal?.removeEventListener('abort', onAbort)
          resolve()
        },
        () => {
          if (settled) return
          settled = true
          signal?.removeEventListener('abort', onAbort)
          resolve()
        }
      )
    })
    return { release, ticket }
  } catch (err) {
    release()
    void ticket.then(() => {
      if (hostQueueTails.get(host) === ticket) hostQueueTails.delete(host)
    })
    throw err
  }
}

async function withHostMutex<T>(
  host: string,
  signal: AbortSignal | undefined,
  worker: () => Promise<T>
): Promise<T> {
  const { release, ticket } = await waitForHostTurn(host, signal)
  try {
    return await worker()
  } finally {
    release()
    if (hostQueueTails.get(host) === ticket) hostQueueTails.delete(host)
  }
}

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
    async (group) =>
      withHostMutex(group.host, signal, async () => {
        for (const target of group.targets) {
          if (signal?.aborted) throw abortError()
          await worker(target)
        }
      }),
    signal
  )
}
