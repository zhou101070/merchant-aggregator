import { describe, expect, it, vi } from 'vitest'
import { fetchAllNodebitsMerchants } from '../fetcher-merchants'
import type { NodebitsClient } from '../client'
import type { NodebitsShopRaw } from '../zod'
import { NODEBITS_ID_PREFIX } from '../normalize'

function shop(partial: Partial<NodebitsShopRaw> & Pick<NodebitsShopRaw, 'id' | 'name'>): NodebitsShopRaw {
  return {
    description: null,
    image_url: null,
    created_at: '2025-01-01T00:00:00.000Z',
    is_pinned: false,
    pinned_at: null,
    favorite_count: 0,
    is_test: false,
    activity_score: 0,
    user_id: null,
    category: null,
    tags: [],
    view_count: 0,
    owner: null,
    ...partial
  }
}

function mockClient(opts: { shops: NodebitsShopRaw[] }): NodebitsClient {
  return {
    fetchShops: vi.fn(async () => opts.shops),
    fetchShopGoTarget: vi.fn(async () => null)
  } as unknown as NodebitsClient
}

describe('fetchAllNodebitsMerchants', () => {
  it('resolves shop URLs via /go, drops test/no-link, keeps rows', async () => {
    const shops = [
      shop({ id: 's-ldxp', name: '链动' }),
      shop({ id: 's-entry', name: '入口' }),
      shop({ id: 's-none', name: '无链' }),
      shop({ id: 's-test', name: '测试', is_test: true })
    ]
    const client = mockClient({ shops })
    const goMap: Record<string, string | null> = {
      's-ldxp': 'https://pay.ldxp.cn/shop/TOK12345',
      's-entry': 'https://other.test/item/1',
      's-none': null
    }
    const resolveShopGo = vi.fn(async (id: string) => goMap[id] ?? null)

    const result = await fetchAllNodebitsMerchants({
      client,
      intervalMs: 0,
      resolveShopGo,
      resolveItem: async () => null
    })

    expect(client.fetchShops).toHaveBeenCalledTimes(1)
    expect(resolveShopGo).toHaveBeenCalledTimes(3) // non-test only
    expect(result.shopsFetched).toBe(4)
    expect(result.droppedTest).toBe(1)
    expect(result.goResolved).toBe(2)
    expect(result.goFailed).toBe(1)
    expect(result.droppedNoLink).toBe(1)
    expect(result.rows).toHaveLength(2)

    const ids = result.rows.map((r) => r.id).sort()
    expect(ids).toEqual(
      [`${NODEBITS_ID_PREFIX}s-entry`, `${NODEBITS_ID_PREFIX}s-ldxp`].sort()
    )

    const ldxp = result.rows.find((r) => r.id.endsWith('s-ldxp'))!
    expect(ldxp.shop_platform).toBe('ldxp')
    expect(ldxp.shop_token).toBe('TOK12345')
    expect(ldxp.shop_url).toBe('https://pay.ldxp.cn/shop/TOK12345')
  })

  it('resolves shopApi item go-target to shop home, drops on resolve miss', async () => {
    const shops = [
      shop({ id: 's-item-ok', name: '可解析' }),
      shop({ id: 's-item-fail', name: '解析失败' })
    ]
    const client = mockClient({ shops })
    const resolveShopGo = vi.fn(async (id: string) =>
      id === 's-item-ok'
        ? 'https://pay.ldxp.cn/item/5ozbbc'
        : 'https://pay.ldxp.cn/item/dead'
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

    const result = await fetchAllNodebitsMerchants({
      client,
      intervalMs: 0,
      resolveShopGo,
      resolveItem
    })

    expect(result.rows).toHaveLength(1)
    expect(result.resolvedFromItem).toBe(1)
    expect(result.droppedItemUnresolved).toBe(1)
    expect(result.droppedNoLink).toBe(1)
    expect(result.rows[0]!.shop_token).toBe('PAXOVOVJ')
    expect(result.rows[0]!.shop_url).toBe('https://pay.ldxp.cn/shop/PAXOVOVJ')
    expect(resolveItem).toHaveBeenCalled()
  })

  it('aborts on signal before shops', async () => {
    const ac = new AbortController()
    ac.abort()
    const client = mockClient({ shops: [] })
    await expect(
      fetchAllNodebitsMerchants({ client, intervalMs: 0, signal: ac.signal })
    ).rejects.toMatchObject({ code: 'CANCELLED' })
  })

  it('reports progress phases including go + resolve', async () => {
    const shops = [shop({ id: 's1', name: 'A' })]
    const client = mockClient({ shops })
    const phases: string[] = []
    await fetchAllNodebitsMerchants({
      client,
      intervalMs: 0,
      resolveShopGo: async () => 'https://example.com/a',
      resolveItem: async () => null,
      onProgress: (p) => phases.push(p.phase)
    })
    expect(phases).toContain('shops')
    expect(phases).toContain('go')
    expect(phases).toContain('resolve')
  })

  it('streams onMerchantsReady per shop as soon as /go (+ item) finishes', async () => {
    const shops = [
      shop({ id: 's-a', name: 'A' }),
      shop({ id: 's-b', name: 'B' }),
      shop({ id: 's-none', name: 'None' })
    ]
    const client = mockClient({ shops })
    const goMap: Record<string, string | null> = {
      's-a': 'https://pay.ldxp.cn/shop/AAAAAAA1',
      's-b': 'https://pay.ldxp.cn/shop/BBBBBBB2',
      's-none': null
    }
    // Serialize go so flush order is deterministic
    let gate = Promise.resolve()
    const resolveShopGo = vi.fn(async (id: string) => {
      const prev = gate
      let release!: () => void
      gate = new Promise<void>((r) => {
        release = r
      })
      await prev
      const url = goMap[id] ?? null
      release()
      return url
    })

    const flushed: string[] = []
    const result = await fetchAllNodebitsMerchants({
      client,
      intervalMs: 0,
      resolveShopGo,
      resolveItem: async () => null,
      onMerchantsReady: (rows) => {
        for (const r of rows) flushed.push(r.id)
      }
    })

    expect(result.rows).toHaveLength(2)
    expect(flushed).toHaveLength(2)
    expect(flushed.sort()).toEqual(
      [`${NODEBITS_ID_PREFIX}s-a`, `${NODEBITS_ID_PREFIX}s-b`].sort()
    )
    // No flush for go-miss
    expect(flushed.some((id) => id.endsWith('s-none'))).toBe(false)
  })

  it('uses client.fetchShopGoTarget when resolveShopGo not injected', async () => {
    const shops = [shop({ id: 's1', name: 'A' })]
    const client = mockClient({ shops })
    ;(client.fetchShopGoTarget as ReturnType<typeof vi.fn>).mockResolvedValue(
      'https://pay.ldxp.cn/shop/FROMGO'
    )
    const result = await fetchAllNodebitsMerchants({
      client,
      intervalMs: 0,
      resolveItem: async () => null
    })
    expect(client.fetchShopGoTarget).toHaveBeenCalledWith('s1', undefined)
    expect(result.rows).toHaveLength(1)
    expect(result.rows[0]!.shop_url).toBe('https://pay.ldxp.cn/shop/FROMGO')
  })
})
