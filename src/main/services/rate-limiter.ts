/**
 * Rate limiting for outbound HTTP.
 *
 * Rule (universal — merchant list + product sync):
 *   Same host → shared interval spacing.
 *   Different hosts → independent; may start in parallel.
 */

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) {
    return Promise.reject(abortError())
  }
  if (ms <= 0) return Promise.resolve()
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = (): void => {
      clearTimeout(timer)
      reject(abortError())
    }
    if (signal) {
      signal.addEventListener('abort', onAbort, { once: true })
    }
  })
}

function abortError(): Error {
  const err = new Error('aborted')
  err.name = 'AbortError'
  return err
}

/**
 * Slot-reservation gap limiter (single lane).
 *
 * Each caller synchronously reserves the next release slot, spaced `intervalMs`
 * from the previous reservation, then sleeps until that slot. This spaces the
 * *start* of consecutive requests even under concurrency.
 */
export class IntervalLimiter {
  /** Earliest release time for the next reservation (epoch ms). */
  private nextAt = 0

  constructor(private readonly intervalMs: number) {}

  async waitTurn(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) throw abortError()
    const now = Date.now()
    // Reserve synchronously: no await between read and write, so concurrent
    // callers each claim a distinct, monotonically spaced slot.
    const scheduledAt = Math.max(now, this.nextAt)
    this.nextAt = scheduledAt + this.intervalMs
    const delay = scheduledAt - now
    if (delay > 0) {
      await sleep(delay, signal)
    }
    if (signal?.aborted) throw abortError()
  }
}

/**
 * Start-gap for paginated shop fetches so `concurrency` can actually fill
 * when limiting is still global.
 */
export function pageStartGapMs(minIntervalMs: number, concurrency: number): number {
  const interval = Math.max(0, Math.floor(minIntervalMs))
  const conc = Math.max(1, Math.floor(concurrency))
  if (!Number.isFinite(interval) || interval <= 0) return 0
  if (conc <= 1) return interval
  return Math.max(0, Math.floor(interval / conc))
}

const FALLBACK_HOST_KEY = '*'

/**
 * Normalize a hostname or absolute URL into a stable limiter key.
 * Empty / unparseable → `*`.
 */
export function hostKey(hostOrUrl: string | null | undefined): string {
  if (!hostOrUrl?.trim()) return FALLBACK_HOST_KEY
  const raw = hostOrUrl.trim()
  try {
    if (/^https?:\/\//i.test(raw)) {
      return new URL(raw).hostname.toLowerCase().replace(/\.$/, '') || FALLBACK_HOST_KEY
    }
  } catch {
    /* fall through */
  }
  // bare host or host:port
  const noPath = raw.split('/')[0]!.split('?')[0]!.trim()
  const host = noPath.toLowerCase().replace(/\.$/, '')
  return host || FALLBACK_HOST_KEY
}

/**
 * Per-host slot-reservation limiter.
 *
 * Concurrent callers each synchronously claim a host key, so different hosts
 * allow up to N starts at once, while the same host stays spaced by intervalMs.
 */
export class PerHostIntervalLimiter {
  private readonly nextAt = new Map<string, number>()

  constructor(private intervalMs: number) {}

  setIntervalMs(ms: number): void {
    const n = Math.floor(ms)
    this.intervalMs = Number.isFinite(n) && n > 0 ? n : 0
  }

  getIntervalMs(): number {
    return this.intervalMs
  }

  /**
   * Reserve a start slot on one of `hostKeys` (or fallback `*`).
   * When multiple keys are offered, picks the freest (earliest ready).
   * Returns the key that was reserved.
   */
  async acquire(hostKeys: readonly string[], signal?: AbortSignal): Promise<string> {
    if (signal?.aborted) throw abortError()
    const keys = uniqueKeys(hostKeys)
    const list = keys.length ? keys : [FALLBACK_HOST_KEY]
    const now = Date.now()
    let bestKey = list[0]!
    let bestScheduled = Number.POSITIVE_INFINITY
    for (const k of list) {
      const at = this.nextAt.get(k) ?? 0
      const scheduled = Math.max(now, at)
      if (scheduled < bestScheduled) {
        bestScheduled = scheduled
        bestKey = k
      }
    }
    // Reserve before await so concurrent acquirers pick distinct free hosts.
    this.nextAt.set(bestKey, bestScheduled + this.intervalMs)
    const delay = bestScheduled - now
    if (delay > 0) {
      await sleep(delay, signal)
    }
    if (signal?.aborted) throw abortError()
    return bestKey
  }

  /** Single-host wait (primary API for outbound HTTP). */
  async waitTurn(host: string, signal?: AbortSignal): Promise<void> {
    await this.acquire([hostKey(host) || FALLBACK_HOST_KEY], signal)
  }

  /** Test helper */
  peekNextAt(host: string): number {
    return this.nextAt.get(hostKey(host)) ?? 0
  }

  clear(): void {
    this.nextAt.clear()
  }
}

/** @deprecated alias — use PerHostIntervalLimiter */
export const PerNodeIntervalLimiter = PerHostIntervalLimiter
export type PerNodeIntervalLimiter = PerHostIntervalLimiter

function uniqueKeys(keys: readonly string[]): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const raw of keys) {
    const k = hostKey(raw)
    if (!k || seen.has(k)) continue
    seen.add(k)
    out.push(k)
  }
  return out
}

/** Process-wide outbound host limiter (merchant list + product sync share this). */
let sharedHostLimiter: PerHostIntervalLimiter | null = null

export function getHostLimiter(intervalMs: number): PerHostIntervalLimiter {
  if (!sharedHostLimiter) {
    sharedHostLimiter = new PerHostIntervalLimiter(intervalMs)
  } else {
    sharedHostLimiter.setIntervalMs(intervalMs)
  }
  return sharedHostLimiter
}

/** @deprecated use getHostLimiter */
export function getShopNodeLimiter(intervalMs: number): PerHostIntervalLimiter {
  return getHostLimiter(intervalMs)
}

/** Test-only reset */
export function resetHostLimiterForTests(): void {
  sharedHostLimiter = null
}

/** @deprecated use resetHostLimiterForTests */
export function resetShopNodeLimiterForTests(): void {
  resetHostLimiterForTests()
}

/**
 * Run `worker` over items with at most `concurrency` in flight.
 * Different hosts stay independent when workers call getHostLimiter().waitTurn(host).
 * Results preserve input order.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>,
  signal?: AbortSignal
): Promise<R[]> {
  const n = items.length
  if (n === 0) return []
  const conc = Math.max(1, Math.min(n, Math.floor(concurrency) || 1))
  const results = new Array<R>(n)
  let next = 0

  const runOne = async (): Promise<void> => {
    while (true) {
      if (signal?.aborted) throw abortError()
      const i = next
      next += 1
      if (i >= n) return
      results[i] = await worker(items[i]!, i)
    }
  }

  const runners = Array.from({ length: conc }, () => runOne())
  await Promise.all(runners)
  return results
}
