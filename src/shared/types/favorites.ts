export type FavoriteTargetType = 'merchant' | 'shop_product'

export interface Favorite {
  id: number
  targetType: FavoriteTargetType
  targetId: string
  note: string | null
  createdAt: string
  titleSnapshot?: string
  /** 当前价(shop_product 收藏,join 本地库) */
  price?: number | null
  currency?: string | null
  stock?: number | null
  sourceUrl?: string | null
  /** 本地数据抓取时间,用于新鲜度展示 */
  fetchedAt?: string | null
  /** 关联商家 id(商品收藏为所属店;商家收藏为自身) */
  merchantId?: string | null
  /** shop_products.source / merchants.shop_platform */
  platformId?: string | null
  shopToken?: string | null
  /** @deprecated dual-fill from shopToken */
  ldxpToken?: string | null
}

export interface RecentView {
  targetType: string
  targetId: string
  titleSnapshot: string | null
  viewedAt: string
}
