import { describe, expect, it, vi } from 'vitest'
import { IndexedTaskError, TaskManager } from '../task-manager'

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) {
    const err = new Error('aborted')
    err.name = 'AbortError'
    return Promise.reject(err)
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms)
    const onAbort = (): void => {
      clearTimeout(timer)
      const err = new Error('aborted')
      err.name = 'AbortError'
      reject(err)
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

describe('TaskManager.runIndexed', () => {
  it('applies results in ascending order even when fetch completes out of order', async () => {
    const tm = new TaskManager(3)
    const order: number[] = []
    await tm.runIndexed({
      from: 1,
      to: 5,
      fetch: async (i) => {
        await delay(i === 1 ? 40 : 5)
        return i * 10
      },
      onResult: (i, v) => {
        order.push(i)
        expect(v).toBe(i * 10)
      }
    })
    expect(order).toEqual([1, 2, 3, 4, 5])
  })

  it('stops producing after onResult stop and discards higher results', async () => {
    const tm = new TaskManager(3)
    const fetched: number[] = []
    const applied: number[] = []
    await tm.runIndexed({
      from: 1,
      to: 20,
      fetch: async (i) => {
        fetched.push(i)
        await delay(10)
        return i
      },
      onResult: (i) => {
        applied.push(i)
        if (i === 2) return { stop: true }
      }
    })
    expect(applied).toEqual([1, 2])
    // Window may have launched 1..concurrency ahead of commit, not the whole range
    expect(Math.max(...fetched)).toBeLessThanOrEqual(2 + 3 - 1)
    expect(fetched.every((i) => i <= 4)).toBe(true)
  })

  it('limits prefetch to concurrency ahead of commit head', async () => {
    const tm = new TaskManager(2)
    const launched: number[] = []
    const gate = new Map<number, () => void>()

    const p = tm.runIndexed({
      from: 1,
      to: 10,
      fetch: (i) =>
        new Promise<number>((resolve) => {
          launched.push(i)
          gate.set(i, () => resolve(i))
        }),
      onResult: (i) => {
        if (i >= 2) return { stop: true }
      }
    })

    await delay(10)
    // Commit head at 1 → may only open indices 1 and 2
    expect(launched.sort((a, b) => a - b)).toEqual([1, 2])

    // Complete page 2 first; still blocked on commit head 1 → no index 3
    gate.get(2)?.()
    await delay(10)
    expect(launched).toHaveLength(2)

    gate.get(1)?.()
    await p
    // After applying 1 then 2 with stop, must not have launched the whole range
    expect(Math.max(...launched)).toBeLessThanOrEqual(3)
  })

  it('works with concurrency 1', async () => {
    const tm = new TaskManager(1)
    const order: number[] = []
    await tm.runIndexed({
      from: 1,
      to: 3,
      fetch: async (i) => i,
      onResult: (i) => {
        order.push(i)
      }
    })
    expect(order).toEqual([1, 2, 3])
  })

  it('throws IndexedTaskError with failing index after drain', async () => {
    const tm = new TaskManager(3)
    const settled: number[] = []
    await expect(
      tm.runIndexed({
        from: 1,
        to: 5,
        fetch: async (i) => {
          await delay(i === 2 ? 5 : 30)
          if (i === 2) throw new Error('boom')
          settled.push(i)
          return i
        },
        onResult: () => {}
      })
    ).rejects.toMatchObject({ name: 'IndexedTaskError', index: 2 })

    // Higher in-flight should have been allowed to settle
    await delay(50)
    expect(settled.length).toBeGreaterThan(0)
  })

  it('abort stops further onResult and drains in-flight', async () => {
    const tm = new TaskManager(3)
    const c = new AbortController()
    const applied: number[] = []
    let inFlightFinished = 0

    const run = tm.runIndexed({
      from: 1,
      to: 10,
      signal: c.signal,
      fetch: async (i) => {
        try {
          await delay(80, c.signal)
          return i
        } finally {
          inFlightFinished += 1
        }
      },
      onResult: (i) => {
        applied.push(i)
      }
    })

    await delay(15)
    c.abort()
    await expect(run).rejects.toMatchObject({ name: 'AbortError' })
    const appliedAfter = applied.length
    await delay(100)
    expect(applied.length).toBe(appliedAfter)
    expect(inFlightFinished).toBeGreaterThan(0)
  })

  it('rejects immediately when already aborted', async () => {
    const tm = new TaskManager(2)
    const c = new AbortController()
    c.abort()
    const fetch = vi.fn(async (i: number) => i)
    await expect(
      tm.runIndexed({
        from: 1,
        to: 5,
        signal: c.signal,
        fetch,
        onResult: () => {}
      })
    ).rejects.toMatchObject({ name: 'AbortError' })
    expect(fetch).not.toHaveBeenCalled()
  })

  it('wraps cause on IndexedTaskError', async () => {
    const tm = new TaskManager(1)
    try {
      await tm.runIndexed({
        from: 1,
        to: 1,
        fetch: async () => {
          throw new Error('network down')
        },
        onResult: () => {}
      })
      expect.unreachable()
    } catch (err) {
      expect(err).toBeInstanceOf(IndexedTaskError)
      expect((err as IndexedTaskError).cause).toMatchObject({ message: 'network down' })
      expect((err as IndexedTaskError).index).toBe(1)
    }
  })
})
