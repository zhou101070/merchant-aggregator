import { describe, expect, it } from 'vitest'
import { RequestBudget } from '../request-budget'

describe('RequestBudget', () => {
  it('limits concurrent acquires', async () => {
    const b = new RequestBudget(2)
    await b.acquire()
    await b.acquire()
    expect(b.used).toBe(2)
    let third = false
    const p = b.acquire().then(() => {
      third = true
    })
    await Promise.resolve()
    expect(third).toBe(false)
    b.release()
    await p
    expect(third).toBe(true)
    expect(b.used).toBe(2)
    b.release()
    b.release()
    expect(b.used).toBe(0)
  })

  it('aborts waiter on signal', async () => {
    const b = new RequestBudget(1)
    await b.acquire()
    const ac = new AbortController()
    const p = b.acquire(ac.signal)
    ac.abort()
    await expect(p).rejects.toMatchObject({ name: 'AbortError' })
    b.release()
  })
})
