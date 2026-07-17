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

/** Weak compare by title across shop products (no PriceAI catalog). */
export type CompareRequest = { titleNorm: string }

export interface CompareResult {
  mode: 'weak_title'
  product: null
  rows: import('./search').SearchHit[]
  /** UI banner: explain weak aggregation / token overlap */
  notice?: string
  /** Tokens used for matching */
  tokens?: string[]
}
