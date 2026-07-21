import { describe, expect, it } from 'vitest'
import {
  extractWholesaleActionId,
  parseAutopixelShopRef,
  parseFlightActionPayload,
  type AutopixelProduct
} from '../client'
import {
  isAutopixelProductListed,
  normalizeAutopixelProducts,
  productPrice
} from '../normalize'

const ref = parseAutopixelShopRef({
  shopUrl: 'https://autopixel.qzz.io/blackcat'
})!

describe('autopixel parse + normalize', () => {
  it('parseAutopixelShopRef from URL and host/slug token', () => {
    expect(parseAutopixelShopRef({ shopUrl: 'https://autopixel.qzz.io/blackcat' })).toEqual({
      host: 'autopixel.qzz.io',
      slug: 'blackcat',
      baseUrl: 'https://autopixel.qzz.io',
      shopPageUrl: 'https://autopixel.qzz.io/blackcat',
      token: 'autopixel.qzz.io/blackcat'
    })
    expect(parseAutopixelShopRef({ token: 'autopixel.qzz.io/blackcat' })?.token).toBe(
      'autopixel.qzz.io/blackcat'
    )
    expect(parseAutopixelShopRef({ shopUrl: 'https://autopixel.qzz.io/' })).toBeNull()
    expect(parseAutopixelShopRef({ shopUrl: 'https://autopixel.qzz.io/api/foo' })).toBeNull()
  })

  it('extractWholesaleActionId from minified createServerReference', () => {
    const js =
      'let L=(0,T.createServerReference)("00beefc26b8e34ceee044e667289806fb1be6c84c7",T.callServer,void 0,T.findSourceMapURL,"fetchWholesaleProductsAction")'
    expect(extractWholesaleActionId(js)).toBe('00beefc26b8e34ceee044e667289806fb1be6c84c7')
  })

  it('parseFlightActionPayload reads numbered flight line', () => {
    const text =
      '0:{"a":"$@1","f":""}\n1:{"success":true,"data":[{"id":1,"name":"A"}]}\n'
    const payload = parseFlightActionPayload(text) as { success: boolean; data: unknown[] }
    expect(payload.success).toBe(true)
    expect(payload.data).toHaveLength(1)
  })

  it('normalize keeps wholesale-active products with wholesale price', () => {
    const list: AutopixelProduct[] = [
      {
        id: 38,
        name: 'Gemini Ultra',
        wholesale_name: 'Gemini Ultra 批发',
        price: 240,
        wholesale_price: 168,
        stock_count: 0,
        is_active: true,
        is_wholesale_active: true,
        is_archived: false,
        category: 'Gemini',
        delivery_type: 'static'
      },
      {
        id: 99,
        name: 'Archived',
        price: 10,
        wholesale_price: 8,
        is_archived: true,
        is_wholesale_active: true
      },
      {
        id: 100,
        name: 'Retail only',
        price: 10,
        is_wholesale_active: false
      }
    ]
    const rows = normalizeAutopixelProducts(list, {
      ref,
      merchantId: 'm1',
      shopName: 'BlackCat',
      fetchedAt: '2026-01-01T00:00:00.000Z'
    })
    expect(rows).toHaveLength(1)
    expect(rows[0].source_goods_key).toBe('38')
    expect(rows[0].title).toBe('Gemini Ultra 批发')
    expect(rows[0].price).toBe(168)
    expect(rows[0].market_price).toBe(240)
    expect(rows[0].stock).toBe(0)
    expect(rows[0].source_shop_token).toBe('autopixel.qzz.io/blackcat')
    expect(isAutopixelProductListed(list[1]!)).toBe(false)
    expect(productPrice(list[0]!)).toBe(168)
  })
})
