export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Simple serial gap limiter. */
export class IntervalLimiter {
  private lastAt = 0

  constructor(private readonly intervalMs: number) {}

  async waitTurn(): Promise<void> {
    const now = Date.now()
    const elapsed = now - this.lastAt
    if (this.lastAt > 0 && elapsed < this.intervalMs) {
      await sleep(this.intervalMs - elapsed)
    }
    this.lastAt = Date.now()
  }
}
