export interface ShopProduct {
  id: string
  source: string
  merchantId: string | null
  sourceShopToken: string
  sourceGoodsKey: string
  sourceUrl: string | null
  shopName: string | null
  title: string
  price: number | null
  marketPrice: number | null
  currency: string | null
  goodsType: string | null
  categoryId: number | null
  categoryName: string | null
  stock: number | null
  image: string | null
  descriptionText: string | null
  fetchedAt: string
}

export interface ShopProductListQuery {
  merchantId?: string
  token?: string
  q?: string
  offset: number
  limit: number
}

/** Single-product stock refresh (keywords + goods_key match, not full shop scrape). */
export interface RefreshStockRequest {
  /** shop_products.id or search hit id `shop:{id}` */
  productId: string
}

export type RefreshStockResult =
  | { status: 'updated'; productId: string; stock: number; product: ShopProduct }
  | { status: 'removed'; productId: string; stock: number | null }
  | { status: 'not_found'; productId: string }

