/**
 * Global in-flight request budget for pool shop scrape.
 * acquire/release pair; waiters wake FIFO when a slot frees.
 */
export class RequestBudget {
  private inFlight = 0
  private readonly waiters: Array<() => void> = []

  constructor(readonly limit: number) {
    if (!Number.isFinite(limit) || limit < 1) {
      throw new Error(`RequestBudget limit must be >= 1, got ${limit}`)
    }
  }

  get used(): number {
    return this.inFlight
  }

  async acquire(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) throw abortError()
    while (this.inFlight >= this.limit) {
      await new Promise<void>((resolve, reject) => {
        const onAbort = (): void => {
          const i = this.waiters.indexOf(wake)
          if (i >= 0) this.waiters.splice(i, 1)
          reject(abortError())
        }
        const wake = (): void => {
          signal?.removeEventListener('abort', onAbort)
          resolve()
        }
        this.waiters.push(wake)
        signal?.addEventListener('abort', onAbort, { once: true })
      })
      if (signal?.aborted) throw abortError()
    }
    this.inFlight += 1
  }

  release(): void {
    if (this.inFlight > 0) this.inFlight -= 1
    const next = this.waiters.shift()
    next?.()
  }
}

function abortError(): Error {
  const e = new Error('aborted')
  e.name = 'AbortError'
  return e
}
