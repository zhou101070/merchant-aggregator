import { describe, expect, it } from 'vitest'
import type { ShopScrapeTarget } from '../../platforms/registry'
import { sleep } from '../rate-limiter'
import { groupShopTargetsByHost, runHostGroupedQueue } from '../shop-queue'

function target(
  platformId: string,
  token: string,
  extra?: Partial<ShopScrapeTarget>
): ShopScrapeTarget {
  return { platformId, token, merchantId: null, ...extra }
}

describe('groupShopTargetsByHost', () => {
  it('returns empty for empty input', () => {
    expect(groupShopTargetsByHost([])).toEqual([])
  })

  it('groups shopApi targets by profile base host', () => {
    const targets = [
      target('ldxp', 'A'),
      target('catfk', 'B'),
      target('ldxp', 'C'),
      target('catfk', 'D')
    ]
    const groups = groupShopTargetsByHost(targets)
    expect(groups.map((g) => g.host)).toEqual(['pay.ldxp.cn', 'catfk.com'])
    expect(groups[0]!.targets.map((t) => t.token)).toEqual(['A', 'C'])
    expect(groups[1]!.targets.map((t) => t.token)).toEqual(['B', 'D'])
  })

  it('groups host-token targets by token/baseUrl host', () => {
    const targets = [
      target('dujiao', 'shop-a.example.com'),
      target('dujiao', 'shop-b.example.com'),
      target('dujiao', 'shop-a.example.com', {
        baseUrl: 'https://shop-a.example.com'
      })
    ]
    const groups = groupShopTargetsByHost(targets)
    expect(groups).toHaveLength(2)
    expect(groups[0]!.host).toBe('shop-a.example.com')
    expect(groups[0]!.targets).toHaveLength(2)
    expect(groups[1]!.host).toBe('shop-b.example.com')
  })

  it('preserves first-seen host order and within-group relative order', () => {
    const targets = [
      target('catfk', '1'),
      target('ldxp', '2'),
      target('catfk', '3'),
      target('ldxp', '4')
    ]
    const groups = groupShopTargetsByHost(targets)
    expect(groups.map((g) => g.host)).toEqual(['catfk.com', 'pay.ldxp.cn'])
    expect(groups[0]!.targets.map((t) => t.token)).toEqual(['1', '3'])
    expect(groups[1]!.targets.map((t) => t.token)).toEqual(['2', '4'])
  })
})

describe('runHostGroupedQueue', () => {
  it('runs same-host shops sequentially (no overlap)', async () => {
    const targets = [target('ldxp', 'A'), target('ldxp', 'B'), target('ldxp', 'C')]
    const events: string[] = []
    let sameHostInFlight = 0
    let maxSameHostInFlight = 0

    await runHostGroupedQueue(targets, 8, async (t) => {
      sameHostInFlight += 1
      maxSameHostInFlight = Math.max(maxSameHostInFlight, sameHostInFlight)
      events.push(`start:${t.token}`)
      await sleep(25)
      events.push(`end:${t.token}`)
      sameHostInFlight -= 1
    })

    expect(maxSameHostInFlight).toBe(1)
    expect(events).toEqual(['start:A', 'end:A', 'start:B', 'end:B', 'start:C', 'end:C'])
  })

  it('runs different hosts in parallel', async () => {
    const targets = [
      target('ldxp', 'A'),
      target('catfk', 'B'),
      target('ldxp', 'C'),
      target('catfk', 'D')
    ]
    let inFlightHosts = 0
    let maxInFlightHosts = 0
    const active = new Map<string, number>()

    await runHostGroupedQueue(targets, 8, async (t) => {
      const host = t.platformId === 'ldxp' ? 'pay.ldxp.cn' : 'catfk.com'
      const prev = active.get(host) ?? 0
      if (prev === 0) {
        inFlightHosts += 1
        maxInFlightHosts = Math.max(maxInFlightHosts, inFlightHosts)
      }
      active.set(host, prev + 1)
      await sleep(40)
      const next = (active.get(host) ?? 1) - 1
      if (next === 0) {
        active.delete(host)
        inFlightHosts -= 1
      } else {
        active.set(host, next)
      }
    })

    expect(maxInFlightHosts).toBe(2)
  })

  it('caps concurrent host groups at maxHostParallel', async () => {
    const targets = [
      target('dujiao', 'h1.example.com'),
      target('dujiao', 'h2.example.com'),
      target('dujiao', 'h3.example.com'),
      target('dujiao', 'h4.example.com')
    ]
    let inFlight = 0
    let maxInFlight = 0

    await runHostGroupedQueue(targets, 2, async () => {
      inFlight += 1
      maxInFlight = Math.max(maxInFlight, inFlight)
      await sleep(30)
      inFlight -= 1
    })

    expect(maxInFlight).toBeLessThanOrEqual(2)
  })

  it('continues same-host queue after a shop worker failure when worker swallows', async () => {
    const targets = [target('ldxp', 'A'), target('ldxp', 'B')]
    const seen: string[] = []
    await runHostGroupedQueue(targets, 4, async (t) => {
      seen.push(t.token)
      if (t.token === 'A') {
        // orchestrator catches per-shop errors; worker itself does not throw
        return
      }
    })
    expect(seen).toEqual(['A', 'B'])
  })

  it('aborts when signal fires', async () => {
    const c = new AbortController()
    const targets = [
      target('ldxp', 'A'),
      target('ldxp', 'B'),
      target('catfk', 'C')
    ]
    const p = runHostGroupedQueue(
      targets,
      8,
      async () => {
        await sleep(200, c.signal)
      },
      c.signal
    )
    c.abort()
    await expect(p).rejects.toMatchObject({ name: 'AbortError' })
  })
})
