import { describe, expect, it, vi } from 'vitest'
import { fetchAllNodebitsMerchants } from '../fetcher-merchants'
import type { NodebitsClient } from '../client'
import type { NodebitsProductRaw, NodebitsShopRaw } from '../zod'
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

function product(
  partial: Partial<NodebitsProductRaw> & Pick<NodebitsProductRaw, 'id' | 'shop_id'>
): NodebitsProductRaw {
  return {
    title: 'item',
    normalized_title: 'item',
    category: null,
    price: 1,
    currency: 'CNY',
    product_url: null,
    image_url: null,
    stock_status: 'in_stock',
    raw_text: null,
    status: 'active',
    last_seen_at: '2026-07-01T00:00:00.000Z',
    created_at: null,
    updated_at: null,
    product_type: null,
    product_type_name: null,
    stock_count: 1,
    shops: null,
    store_name: null,
    ...partial
  }
}

function mockClient(opts: {
  shops: NodebitsShopRaw[]
  productsByOffset?: (params: {
    limit: number
    offset: number
  }) => { products: NodebitsProductRaw[]; total: number }
  products?: NodebitsProductRaw[]
}): NodebitsClient {
  const all = opts.products ?? []
  return {
    fetchShops: vi.fn(async () => opts.shops),
    fetchProductsPage: vi.fn(
      opts.productsByOffset ??
        (async ({ limit, offset }) => ({
          products: all.slice(offset, offset + limit),
          total: all.length
        }))
    )
  } as unknown as NodebitsClient
}

describe('fetchAllNodebitsMerchants', () => {
  it('paginates products, drops test/no-link shops, keeps enriched rows', async () => {
    const shops = [
      shop({ id: 's-ldxp', name: '链动' }),
      shop({ id: 's-entry', name: '入口' }),
      shop({ id: 's-none', name: '无链' }),
      shop({ id: 's-test', name: '测试', is_test: true })
    ]
    const products = [
      product({
        id: 'p1',
        shop_id: 's-ldxp',
        product_url: 'https://pay.ldxp.cn/shop/TOK12345/x',
        raw_text: JSON.stringify({
          shopUrl: 'https://pay.ldxp.cn/shop/TOK12345',
          source: 'ldxp'
        })
      }),
      product({
        id: 'p2',
        shop_id: 's-entry',
        product_url: 'https://other.test/item/1'
      }),
      product({
        id: 'p3',
        shop_id: 's-none',
        product_url: null
      }),
      product({
        id: 'p4',
        shop_id: 's-test',
        product_url: 'https://pay.ldxp.cn/shop/TESTONLY',
        raw_text: JSON.stringify({ shopUrl: 'https://pay.ldxp.cn/shop/TESTONLY', source: 'ldxp' })
      })
    ]

    const client = mockClient({ shops, products })
    const result = await fetchAllNodebitsMerchants({
      client,
      productLimit: 2,
      intervalMs: 0
    })

    expect(client.fetchShops).toHaveBeenCalledTimes(1)
    expect(client.fetchProductsPage).toHaveBeenCalledTimes(2)
    expect(result.shopsFetched).toBe(4)
    expect(result.droppedTest).toBe(1)
    expect(result.droppedNoLink).toBe(1)
    expect(result.rows).toHaveLength(2)
    expect(result.productsFetched).toBe(4)
    expect(result.productPages).toBe(2)

    const ids = result.rows.map((r) => r.id).sort()
    expect(ids).toEqual([
      `${NODEBITS_ID_PREFIX}s-entry`,
      `${NODEBITS_ID_PREFIX}s-ldxp`
    ].sort())

    const ldxp = result.rows.find((r) => r.id.endsWith('s-ldxp'))!
    expect(ldxp.shop_platform).toBe('ldxp')
    expect(ldxp.shop_token).toBe('TOK12345')
  })

  it('continues when products incomplete (soft incomplete log path)', async () => {
    const shops = [shop({ id: 's1', name: 'A' })]
    const client = mockClient({
      shops,
      productsByOffset: async ({ offset }) => {
        if (offset === 0) {
          return {
            products: [
              product({
                id: 'p1',
                shop_id: 's1',
                product_url: 'https://example.com/a'
              })
            ],
            total: 5
          }
        }
        // short empty-ish tail: empty products while total claims more → break on empty
        return { products: [], total: 5 }
      }
    })

    const result = await fetchAllNodebitsMerchants({ client, productLimit: 100, intervalMs: 0 })
    expect(result.rows).toHaveLength(1)
    expect(result.productsFetched).toBe(1)
    expect(result.productsTotal).toBe(5)
  })

  it('aborts on signal before shops', async () => {
    const ac = new AbortController()
    ac.abort()
    const client = mockClient({ shops: [], products: [] })
    await expect(
      fetchAllNodebitsMerchants({ client, intervalMs: 0, signal: ac.signal })
    ).rejects.toMatchObject({ code: 'CANCELLED' })
  })

  it('reports progress phases', async () => {
    const shops = [shop({ id: 's1', name: 'A' })]
    const products = [
      product({
        id: 'p1',
        shop_id: 's1',
        product_url: 'https://example.com/a'
      })
    ]
    const client = mockClient({ shops, products })
    const phases: string[] = []
    await fetchAllNodebitsMerchants({
      client,
      intervalMs: 0,
      onProgress: (p) => phases.push(p.phase)
    })
    expect(phases).toContain('shops')
    expect(phases).toContain('products')
    expect(phases).toContain('normalize')
  })
})
