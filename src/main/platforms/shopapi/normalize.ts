import type { ShopSiteProfile } from '@shared/platforms/shop-types'
import { itemPageUrl } from '@shared/platforms/shop-types'
import { stripHtml } from '../../services/html-text'
import type { NormalizedShopProductRow } from '../../db/repositories/shop-products-repo'
import type { ShopApiGoodsItem } from './client'

function num(v: unknown): number | null {
  if (v == null || v === '') return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

export function normalizeGoods(
  item: ShopApiGoodsItem,
  opts: {
    profile: ShopSiteProfile
    token: string
    merchantId: string | null
    shopName: string | null
    goodsType: string
    fetchedAt: string
  }
): NormalizedShopProductRow | null {
  const key = item.goods_key
  if (!key) return null
  const stock = num(item.extend?.stock_count)
  const source = opts.profile.sourceId
  const id = `${source}:${opts.token}:${key}`
  return {
    id,
    source,
    merchant_id: opts.merchantId,
    source_shop_token: opts.token,
    source_goods_key: key,
    source_url: item.link || itemPageUrl(opts.profile, key),
    shop_name: item.user?.nickname || opts.shopName,
    title: item.name || key,
    price: num(item.price),
    market_price: num(item.market_price),
    currency: 'CNY',
    goods_type: item.goods_type || opts.goodsType,
    category_id: item.category?.id ?? null,
    category_name: item.category?.name ?? null,
    stock,
    image: item.image ?? null,
    description_text: stripHtml(item.description),
    description_html: null,
    fetched_at: opts.fetchedAt,
    raw_json: JSON.stringify(item)
  }
}
