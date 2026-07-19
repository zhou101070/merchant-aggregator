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
 * Slot-reservation gap limiter.
 *
 * Each caller synchronously reserves the next release slot, spaced `intervalMs`
 * from the previous reservation, then sleeps until that slot. This spaces the
 * *start* of consecutive requests even under concurrency (unlike a naive
 * lastAt-comparison, where simultaneous callers all read the same timestamp and
 * burst through together). Requests may still overlap in flight — that is what
 * lets a concurrent page batch pipeline while keeping an anti-WAF cadence.
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

const FALLBACK_NODE_KEY = '*'

/**
 * Per-key slot-reservation limiter.
 *
 * Concurrent callers each synchronously claim the free-est key, so N keys
 * allow up to N starts at once, while the same key stays spaced by intervalMs.
 */
export class PerNodeIntervalLimiter {
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
   * Reserve a start slot on one of `nodeKeys` (or fallback `*`).
   * Returns the key that was reserved.
   */
  async acquire(nodeKeys: readonly string[], signal?: AbortSignal): Promise<string> {
    if (signal?.aborted) throw abortError()
    const keys = uniqueKeys(nodeKeys)
    const list = keys.length ? keys : [FALLBACK_NODE_KEY]
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
    // Reserve before await so concurrent acquirers pick distinct free nodes.
    this.nextAt.set(bestKey, bestScheduled + this.intervalMs)
    const delay = bestScheduled - now
    if (delay > 0) {
      await sleep(delay, signal)
    }
    if (signal?.aborted) throw abortError()
    return bestKey
  }

  /** Single-key wait (pinned node or legacy global). */
  async waitTurn(nodeKey: string, signal?: AbortSignal): Promise<void> {
    await this.acquire([nodeKey || FALLBACK_NODE_KEY], signal)
  }

  /** Test helper */
  peekNextAt(nodeKey: string): number {
    return this.nextAt.get(nodeKey) ?? 0
  }

  clear(): void {
    this.nextAt.clear()
  }
}

function uniqueKeys(keys: readonly string[]): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const raw of keys) {
    const k = typeof raw === 'string' ? raw.trim() : ''
    if (!k || seen.has(k)) continue
    seen.add(k)
    out.push(k)
  }
  return out
}

/** Process-wide shop outbound limiter. */
let sharedShopNodeLimiter: PerNodeIntervalLimiter | null = null

export function getShopNodeLimiter(intervalMs: number): PerNodeIntervalLimiter {
  if (!sharedShopNodeLimiter) {
    sharedShopNodeLimiter = new PerNodeIntervalLimiter(intervalMs)
  } else {
    sharedShopNodeLimiter.setIntervalMs(intervalMs)
  }
  return sharedShopNodeLimiter
}

/** Test-only reset */
export function resetShopNodeLimiterForTests(): void {
  sharedShopNodeLimiter = null
}
