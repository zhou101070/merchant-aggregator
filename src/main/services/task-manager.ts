/** Error from `runIndexed` with the failing index attached. */
export class IndexedTaskError extends Error {
  readonly index: number
  override readonly cause: unknown

  constructor(index: number, cause: unknown) {
    const msg = cause instanceof Error ? cause.message : String(cause)
    super(msg)
    this.name = 'IndexedTaskError'
    this.index = index
    this.cause = cause
  }
}

function abortError(): Error {
  const err = new Error('aborted')
  err.name = 'AbortError'
  return err
}

/**
 * Sliding-window concurrency scheduler.
 * Keeps at most `concurrency` tasks ahead of the ordered commit head;
 * a free slot within that window immediately starts the next index.
 */
export class TaskManager {
  readonly concurrency: number

  constructor(concurrency: number) {
    const n = Math.floor(concurrency)
    if (!Number.isFinite(n) || n < 1) {
      throw new Error(`TaskManager concurrency must be >= 1, got ${concurrency}`)
    }
    this.concurrency = n
  }

  /**
   * Fetch indices in a sliding window and commit results in ascending order.
   *
   * - `fetch(i)` may complete out of order; `onResult` always runs as i, i+1, i+2…
   * - Launch stays within `[nextToApply, nextToApply + concurrency)` (true sliding window).
   * - `onResult` returning `{ stop: true }` stops producing higher indices; already
   *   in-flight higher fetches still settle, but their results are discarded.
   * - First `fetch` rejection fails the whole run (after in-flight drain) as `IndexedTaskError`.
   * - Abort: stop producing, drain in-flight, then throw `AbortError` (no further `onResult`).
   */
  async runIndexed<T>(options: {
    from?: number
    /** Inclusive upper bound */
    to?: number
    fetch: (index: number) => Promise<T>
    onResult: (index: number, value: T) => void | { stop?: boolean }
    signal?: AbortSignal
  }): Promise<void> {
    const from = options.from ?? 0
    const to = options.to ?? Number.POSITIVE_INFINITY
    if (!Number.isFinite(from) || from > to) return

    let nextToFetch = from
    let nextToApply = from
    let stopProducing = false
    let firstError: unknown = null
    const pending = new Map<number, T>()
    const inFlight = new Map<number, Promise<void>>()

    const isAborted = (): boolean => Boolean(options.signal?.aborted)

    const drain = async (): Promise<void> => {
      if (inFlight.size === 0) return
      await Promise.allSettled([...inFlight.values()])
    }

    const applyPending = (): void => {
      if (firstError || isAborted()) {
        stopProducing = true
        pending.clear()
        return
      }
      while (pending.has(nextToApply)) {
        if (isAborted()) {
          stopProducing = true
          pending.clear()
          return
        }
        const value = pending.get(nextToApply)!
        pending.delete(nextToApply)
        const index = nextToApply
        nextToApply += 1
        const verdict = options.onResult(index, value)
        if (verdict?.stop) {
          stopProducing = true
          pending.clear()
          return
        }
      }
    }

    const launch = (index: number): void => {
      const task = (async () => {
        try {
          const value = await options.fetch(index)
          if (firstError || stopProducing || isAborted()) return
          if (index < nextToApply) return
          pending.set(index, value)
          applyPending()
        } catch (err) {
          if (!firstError) {
            firstError = new IndexedTaskError(index, err)
          }
          stopProducing = true
        } finally {
          inFlight.delete(index)
        }
      })()
      inFlight.set(index, task)
    }

    // Single abort waiter for the whole run (avoid stacking listeners per race).
    let abortRace: Promise<never> | null = null
    if (options.signal) {
      const signal = options.signal
      abortRace = new Promise((_, reject) => {
        if (signal.aborted) {
          reject(abortError())
          return
        }
        signal.addEventListener('abort', () => reject(abortError()), { once: true })
      })
      // Prevent unhandled rejection if abort fires after run finished
      abortRace.catch(() => {})
    }

    try {
      while (true) {
        if (isAborted()) {
          stopProducing = true
          pending.clear()
          await drain()
          throw abortError()
        }

        if (firstError) {
          stopProducing = true
          pending.clear()
          await drain()
          throw firstError
        }

        // Window relative to ordered commit head (not only in-flight count).
        while (
          !stopProducing &&
          !firstError &&
          !isAborted() &&
          nextToFetch <= to &&
          nextToFetch < nextToApply + this.concurrency
        ) {
          launch(nextToFetch)
          nextToFetch += 1
        }

        if (inFlight.size === 0) break

        const racers: Promise<unknown>[] = [...inFlight.values()]
        if (abortRace) racers.push(abortRace)
        try {
          await Promise.race(racers)
        } catch (err) {
          if (err instanceof Error && err.name === 'AbortError') {
            stopProducing = true
            pending.clear()
            await drain()
            throw abortError()
          }
          throw err
        }
      }

      if (isAborted()) {
        stopProducing = true
        pending.clear()
        await drain()
        throw abortError()
      }
      if (firstError) throw firstError
    } finally {
      stopProducing = true
      if (inFlight.size > 0) await drain()
    }
  }
}
