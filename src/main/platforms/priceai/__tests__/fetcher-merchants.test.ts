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
    expect(result.fetchedUnique).toBe(3)
    expect(result.droppedNoLink).toBe(0)
  })

  it('drops merchants without shop_url/entry_url but still completes pagination by unique id', async () => {
    const withLink = merchant('keep')
    const noLink = {
      ...merchant('drop'),
      host: null,
      shopUrl: null,
      entryUrl: null,
      sourceId: null
    }
    const client = mockClient(() =>
      page({
        rows: [withLink, noLink],
        total: 2,
        limited: false,
        limit: 100,
        offset: 0
      })
    )

    const result = await fetchAllMerchants({ client, limit: 100, intervalMs: 0 })
    expect(result.rows.map((r) => r.id)).toEqual(['keep'])
    expect(result.fetchedUnique).toBe(2)
    expect(result.droppedNoLink).toBe(1)
    expect(result.total).toBe(2)
  })

  it('resolves item-only entry_url via goodsInfo hook, drops on miss', async () => {
    const itemOk = {
      ...merchant('item-ok'),
      shopUrl: null as string | null,
      entryUrl: 'https://pay.ldxp.cn/item/5ozbbc'
    }
    const itemFail = {
      ...merchant('item-fail'),
      shopUrl: null as string | null,
      entryUrl: 'https://pay.ldxp.cn/item/dead'
    }
    const client = mockClient(() =>
      page({
        rows: [itemOk, itemFail],
        total: 2,
        limited: false,
        limit: 100,
        offset: 0
      })
    )
    const resolveItem = vi.fn(async (url: string) => {
      if (url.includes('5ozbbc')) {
        return {
          shopUrl: 'https://pay.ldxp.cn/shop/PAXOVOVJ',
          token: 'PAXOVOVJ',
          platformId: 'ldxp'
        }
      }
      return null
    })

    const result = await fetchAllMerchants({
      client,
      limit: 100,
      intervalMs: 0,
      resolveItem
    })
    expect(result.rows).toHaveLength(1)
    expect(result.rows[0]!.id).toBe('item-ok')
    expect(result.rows[0]!.shop_token).toBe('PAXOVOVJ')
    expect(result.resolvedFromItem).toBe(1)
    expect(result.droppedItemUnresolved).toBe(1)
    expect(result.droppedNoLink).toBe(1)
  })

  it('streams onMerchantsReady per page before the next page fetch', async () => {
    const all = Array.from({ length: 5 }, (_, i) => merchant(`m${i}`))
    let pageFetches = 0
    const readyAfterFetch: number[] = []
    const client = mockClient(({ offset, limit }) => {
      pageFetches += 1
      // After page 1 is returned, onMerchantsReady must have fired for prior pages only
      // (this callback runs before flush of the current page).
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

    const flushed: string[][] = []
    const result = await fetchAllMerchants({
      client,
      limit: 2,
      intervalMs: 0,
      onMerchantsReady: (rows) => {
        flushed.push(rows.map((r) => r.id))
        readyAfterFetch.push(pageFetches)
      }
    })

    expect(result.rows).toHaveLength(5)
    // 3 pages (2+2+1); each page flushes once (all shop-home)
    expect(flushed).toEqual([['m0', 'm1'], ['m2', 'm3'], ['m4']])
    // Flush happens after each page fetch, before subsequent fetches complete the loop
    expect(readyAfterFetch[0]).toBe(1)
    expect(readyAfterFetch[1]).toBe(2)
    expect(readyAfterFetch[2]).toBe(3)
    // Cumulative ready equals final result
    expect(flushed.flat()).toEqual(result.rows.map((r) => r.id))
  })

  it('flushes shop-home rows before item resolve on the same page', async () => {
    const home = merchant('home')
    const itemOnly = {
      ...merchant('item'),
      shopUrl: null as string | null,
      entryUrl: 'https://pay.ldxp.cn/item/5ozbbc'
    }
    const client = mockClient(() =>
      page({
        rows: [home, itemOnly],
        total: 2,
        limited: false,
        limit: 100,
        offset: 0
      })
    )
    const order: string[] = []
    let resolveStarted = false
    const resolveItem = vi.fn(async () => {
      resolveStarted = true
      return {
        shopUrl: 'https://pay.ldxp.cn/shop/ITEMTOK1',
        token: 'ITEMTOK1',
        platformId: 'ldxp'
      }
    })

    await fetchAllMerchants({
      client,
      limit: 100,
      intervalMs: 0,
      resolveItem,
      onMerchantsReady: (rows) => {
        for (const r of rows) {
          order.push(r.id)
          if (r.id === 'home') {
            // shop-home must land before goodsInfo is even called
            expect(resolveStarted).toBe(false)
          }
        }
      }
    })

    expect(order).toEqual(['home', 'item'])
    expect(resolveItem).toHaveBeenCalledTimes(1)
  })
})
