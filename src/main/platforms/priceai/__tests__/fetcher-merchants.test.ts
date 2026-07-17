import { describe, expect, it, vi } from 'vitest'
import { fetchAllMerchants } from '../fetcher-merchants'
import type { PriceaiClient } from '../client'
import type { PriceaiMerchantsPageParsed } from '../zod'

function merchant(id: string) {
  return {
    id,
    name: `Shop ${id}`,
    storeName: `Shop ${id}`,
    host: 'pay.ldxp.cn',
    shopUrl: `https://pay.ldxp.cn/shop/${id}`,
    entryUrl: `https://pay.ldxp.cn/shop/${id}`,
    sourceId: `ldxp-${id}`,
    healthStatus: 'healthy',
    offerCount: 1,
    platforms: ['ChatGPT'],
    productTypes: ['成品账号'],
    hasPlatformAftersalesMechanism: true
  }
}

function page(
  partial: Partial<PriceaiMerchantsPageParsed> & {
    rows: PriceaiMerchantsPageParsed['rows']
  }
): PriceaiMerchantsPageParsed {
  return {
    total: partial.total ?? partial.rows.length,
    message: null,
    degraded: false,
    generatedAt: '2026-07-17T00:00:00.000Z',
    limited: partial.limited ?? false,
    limit: partial.limit ?? 100,
    offset: partial.offset ?? 0,
    rows: partial.rows
  }
}

function mockClient(
  impl: (params: {
    limit: number
    offset: number
  }) => PriceaiMerchantsPageParsed | Promise<PriceaiMerchantsPageParsed>
): PriceaiClient {
  return {
    fetchMerchantsPage: vi.fn(impl)
  } as unknown as PriceaiClient
}

describe('fetchAllMerchants pagination', () => {
  it('walks all pages including partial last page', async () => {
    const all = Array.from({ length: 233 }, (_, i) => merchant(`m${i}`))
    const client = mockClient(({ offset, limit }) => {
      const rows = all.slice(offset, offset + limit)
      const next = offset + rows.length
      return page({
        rows,
        total: all.length,
        limited: next < all.length,
        limit,
        offset
      })
    })

    const result = await fetchAllMerchants({ client, limit: 100, intervalMs: 0 })
    expect(result.rows).toHaveLength(233)
    expect(result.total).toBe(233)
    expect(result.pages).toBe(3)
    expect(client.fetchMerchantsPage).toHaveBeenCalledTimes(3)
    expect(client.fetchMerchantsPage).toHaveBeenNthCalledWith(1, { limit: 100, offset: 0 })
    expect(client.fetchMerchantsPage).toHaveBeenNthCalledWith(2, { limit: 100, offset: 100 })
    expect(client.fetchMerchantsPage).toHaveBeenNthCalledWith(3, { limit: 100, offset: 200 })
  })

  it('stops on exact full last page via limited=false (does not require short page)', async () => {
    const all = Array.from({ length: 200 }, (_, i) => merchant(`m${i}`))
    const client = mockClient(({ offset, limit }) => {
      const rows = all.slice(offset, offset + limit)
      return page({
        rows,
        total: all.length,
        limited: offset + rows.length < all.length,
        limit,
        offset
      })
    })

    const result = await fetchAllMerchants({ client, limit: 100, intervalMs: 0 })
    expect(result.rows).toHaveLength(200)
    expect(result.pages).toBe(2)
  })

  it('fails (not silent success) on empty page before total exhausted', async () => {
    const client = mockClient(({ offset }) => {
      if (offset === 0) {
        return page({
          rows: Array.from({ length: 100 }, (_, i) => merchant(`m${i}`)),
          total: 250,
          limited: true,
          limit: 100,
          offset: 0
        })
      }
      // Bug-like mid-stream empty while claiming more remain
      return page({
        rows: [],
        total: 250,
        limited: true,
        limit: 100,
        offset
      })
    })

    await expect(fetchAllMerchants({ client, limit: 100, intervalMs: 0 })).rejects.toMatchObject({
      code: 'NETWORK',
      message: expect.stringMatching(/empty page before total exhausted|incomplete/)
    })
  })

  it('fails on short page while limited=true (old logic would drop the tail)', async () => {
    const client = mockClient(({ offset }) => {
      if (offset === 0) {
        return page({
          // Only 50 of 100 — historically stopped here while total=250
          rows: Array.from({ length: 50 }, (_, i) => merchant(`m${i}`)),
          total: 250,
          limited: true,
          limit: 100,
          offset: 0
        })
      }
      return page({ rows: [], total: 250, limited: false, limit: 100, offset })
    })

    await expect(fetchAllMerchants({ client, limit: 100, intervalMs: 0 })).rejects.toMatchObject({
      code: 'NETWORK',
      message: expect.stringMatching(/short page while limited=true/)
    })
  })

  it('fails when accumulated unique rows stay below API total after stop', async () => {
    // limited=false too early with full pages → old code would succeed with 100/250
    const client = mockClient(() =>
      page({
        rows: Array.from({ length: 100 }, (_, i) => merchant(`m${i}`)),
        total: 250,
        limited: false,
        limit: 100,
        offset: 0
      })
    )

    await expect(fetchAllMerchants({ client, limit: 100, intervalMs: 0 })).rejects.toMatchObject({
      code: 'NETWORK',
      message: expect.stringMatching(/incomplete after pagination: got 100\/250/)
    })
  })

  it('dedupes ids across pages without double-counting toward total', async () => {
    const client = mockClient(({ offset }) => {
      if (offset === 0) {
        return page({
          rows: [merchant('a'), merchant('b')],
          total: 3,
          limited: true,
          limit: 2,
          offset: 0
        })
      }
      return page({
        rows: [merchant('b'), merchant('c')], // b duplicate
        total: 3,
        limited: false,
        limit: 2,
        offset: 2
      })
    })

    const result = await fetchAllMerchants({ client, limit: 2, intervalMs: 0 })
    expect(result.rows.map((r) => r.id).sort()).toEqual(['a', 'b', 'c'])
    expect(result.total).toBe(3)
  })
})
