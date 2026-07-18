export interface LatestTaskContext {
  isCurrent: () => boolean
}

/** Serial task queue where a newly queued task immediately supersedes older work. */
export class LatestTaskQueue {
  private revision = 0
  private tail: Promise<void> = Promise.resolve()

  async enqueue(task: (ctx: LatestTaskContext) => Promise<void>): Promise<void> {
    const revision = ++this.revision
    const isCurrent = (): boolean => revision === this.revision
    const run = this.tail.then(() => task({ isCurrent }))
    this.tail = run.catch(() => {})
    await run
    if (!isCurrent()) await this.tail
  }

  invalidate(): void {
    this.revision += 1
  }
}
