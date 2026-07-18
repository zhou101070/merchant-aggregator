import { describe, expect, it } from 'vitest'
import { LatestTaskQueue } from '../latest-task-queue'

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve = (): void => {}
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

describe('LatestTaskQueue', () => {
  it('serializes work and lets only the latest request commit', async () => {
    const queue = new LatestTaskQueue()
    const gate = deferred()
    const committed: string[] = []
    const first = queue.enqueue(async ({ isCurrent }) => {
      await gate.promise
      if (isCurrent()) committed.push('first')
    })
    const second = queue.enqueue(async ({ isCurrent }) => {
      if (isCurrent()) committed.push('second')
    })

    gate.resolve()
    await Promise.all([first, second])
    expect(committed).toEqual(['second'])
  })

  it('invalidates in-flight work without queuing a replacement', async () => {
    const queue = new LatestTaskQueue()
    const gate = deferred()
    let committed = false
    const run = queue.enqueue(async ({ isCurrent }) => {
      await gate.promise
      committed = isCurrent()
    })
    queue.invalidate()
    gate.resolve()
    await run
    expect(committed).toBe(false)
  })
})
