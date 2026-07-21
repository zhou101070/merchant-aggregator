import { describe, expect, it } from 'vitest'
import {
  hostKey,
  IntervalLimiter,
  mapWithConcurrency,
  pageStartGapMs,
  PerHostIntervalLimiter,
  PerNodeIntervalLimiter,
  resetHostLimiterForTests,
  resetShopNodeLimiterForTests,
  sleep
} from '../rate-limiter'

describe('sleep abort', () => {
  it('rejects immediately when already aborted', async () => {
    const c = new AbortController()
    c.abort()
    await expect(sleep(1000, c.signal)).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('rejects when aborted during wait', async () => {
    const c = new AbortController()
    const p = sleep(5000, c.signal)
    c.abort()
    await expect(p).rejects.toMatchObject({ name: 'AbortError' })
  })
})

describe('IntervalLimiter.waitTurn abort', () => {
  it('throws when aborted during gap wait', async () => {
    const limiter = new IntervalLimiter(2000)
    await limiter.waitTurn()
    const c = new AbortController()
    const p = limiter.waitTurn(c.signal)
    c.abort()
    await expect(p).rejects.toMatchObject({ name: 'AbortError' })
  })
})

describe('IntervalLimiter concurrent spacing', () => {
  it('spaces the release of simultaneously started calls by the interval', async () => {
    const interval = 100
    const limiter = new IntervalLimiter(interval)
    const start = Date.now()
    const releasedAt = await Promise.all(
      [0, 1, 2, 3].map(async () => {
        await limiter.waitTurn()
        return Date.now() - start
      })
    )
    // First fires immediately; each subsequent one is ~interval later, not a burst.
    for (let i = 1; i < releasedAt.length; i++) {
      const gap = releasedAt[i] - releasedAt[i - 1]
      expect(gap).toBeGreaterThanOrEqual(interval - 30)
    }
  })
})

describe('pageStartGapMs', () => {
  it('keeps full interval when concurrency is 1', () => {
    expect(pageStartGapMs(500, 1)).toBe(500)
  })

  it('spreads starts so concurrency can fill', () => {
    expect(pageStartGapMs(500, 10)).toBe(50)
    expect(pageStartGapMs(500, 5)).toBe(100)
  })
})

describe('hostKey', () => {
  it('normalizes urls and bare hosts', () => {
    expect(hostKey('https://pay.ldxp.cn/shop/ABC')).toBe('pay.ldxp.cn')
    expect(hostKey('CATFK.COM')).toBe('catfk.com')
    expect(hostKey(null)).toBe('*')
  })
})

describe('PerHostIntervalLimiter', () => {
  it('lets different hosts start immediately', async () => {
    const lim = new PerHostIntervalLimiter(500)
    const start = Date.now()
    const keys = await Promise.all([
      lim.acquire(['a', 'b', 'c']),
      lim.acquire(['a', 'b', 'c']),
      lim.acquire(['a', 'b', 'c'])
    ])
    const elapsed = Date.now() - start
    expect(new Set(keys).size).toBe(3)
    expect(elapsed).toBeLessThan(80)
  })

  it('spaces the same host by interval', async () => {
    const lim = new PerHostIntervalLimiter(100)
    const start = Date.now()
    await lim.waitTurn('only.example')
    await lim.waitTurn('only.example')
    expect(Date.now() - start).toBeGreaterThanOrEqual(70)
  })

  it('pinned single key does not use other hosts', async () => {
    const lim = new PerHostIntervalLimiter(200)
    await lim.acquire(['a'])
    const t0 = Date.now()
    // only 'a' offered — must wait even if b is free
    await lim.acquire(['a'])
    expect(Date.now() - t0).toBeGreaterThanOrEqual(150)
    expect(lim.peekNextAt('b')).toBe(0)
  })

  it('aliases still work', async () => {
    const lim = new PerNodeIntervalLimiter(50)
    await lim.waitTurn('x')
    resetShopNodeLimiterForTests()
    resetHostLimiterForTests()
  })
})

describe('mapWithConcurrency', () => {
  it('preserves order and caps in-flight workers', async () => {
    let inFlight = 0
    let maxInFlight = 0
    const out = await mapWithConcurrency([1, 2, 3, 4, 5], 2, async (n) => {
      inFlight += 1
      maxInFlight = Math.max(maxInFlight, inFlight)
      await sleep(30)
      inFlight -= 1
      return n * 10
    })
    expect(out).toEqual([10, 20, 30, 40, 50])
    expect(maxInFlight).toBeLessThanOrEqual(2)
  })

  it('aborts when signal fires', async () => {
    const c = new AbortController()
    const p = mapWithConcurrency(
      [1, 2, 3],
      1,
      async () => {
        await sleep(200, c.signal)
        return 1
      },
      c.signal
    )
    c.abort()
    await expect(p).rejects.toMatchObject({ name: 'AbortError' })
  })
})
