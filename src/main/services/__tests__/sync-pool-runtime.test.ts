import { describe, expect, it } from 'vitest'
import { storeKeyOf, SyncPoolRuntime } from '../sync-pool-runtime'
import type { ShopScrapeTarget } from '../../platforms/registry'

describe('SyncPoolRuntime', () => {
  it('does not allow commit before expectedFinal', () => {
    const snaps: unknown[] = []
    const rt = new SyncPoolRuntime(
      'job1',
      {
        discoverConcurrency: 1,
        requestBudget: 3,
        startConsumeAt: 3,
        maxOpenStores: 2
      },
      (s) => snaps.push(s)
    )
    const target: ShopScrapeTarget = {
      platformId: 'ldxp',
      token: 't1',
      merchantId: 'm1'
    }
    rt.enqueueMerchants([target])
    const mid = rt.merchants[0]!.id
    const sk = storeKeyOf('ldxp', 't1')
    const acc = rt.accumulators.get(sk)!
    expect(acc.expectedFinal).toBe(false)

    rt.finalizeDiscover(mid, ['card', 'article'])
    expect(acc.expectedFinal).toBe(true)
    expect(acc.expectedGroups).toBe(2)
    expect(rt.groups).toHaveLength(2)
    expect(rt.merchants[0]!.status).toBe('discovered')
    expect(snaps.length).toBeGreaterThan(0)
  })
})
