import { z } from 'zod'

export const nodebitsShopRawSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    description: z.string().nullish(),
    image_url: z.string().nullish(),
    created_at: z.string().nullish(),
    is_pinned: z.boolean().nullish(),
    pinned_at: z.string().nullish(),
    favorite_count: z.number().nullish(),
    is_test: z.boolean().nullish(),
    activity_score: z.number().nullish(),
    user_id: z.string().nullish(),
    category: z.string().nullish(),
    tags: z.array(z.string()).nullish(),
    view_count: z.number().nullish(),
    owner: z
      .object({
        username: z.string().nullish(),
        avatar_url: z.string().nullish()
      })
      .passthrough()
      .nullish()
  })
  .passthrough()

export const nodebitsShopsResponseSchema = z.object({
  shops: z.array(nodebitsShopRawSchema)
})

export const nodebitsProductRawSchema = z
  .object({
    id: z.string().min(1),
    shop_id: z.string().min(1),
    title: z.string().nullish(),
    normalized_title: z.string().nullish(),
    category: z.string().nullish(),
    price: z.number().nullish(),
    currency: z.string().nullish(),
    product_url: z.string().nullish(),
    image_url: z.string().nullish(),
    stock_status: z.string().nullish(),
    raw_text: z.string().nullish(),
    status: z.string().nullish(),
    last_seen_at: z.string().nullish(),
    created_at: z.string().nullish(),
    updated_at: z.string().nullish(),
    product_type: z.string().nullish(),
    product_type_name: z.string().nullish(),
    stock_count: z.number().nullish(),
    shops: z
      .object({
        name: z.string().nullish()
      })
      .passthrough()
      .nullish(),
    store_name: z.string().nullish()
  })
  .passthrough()

export const nodebitsProductsPageSchema = z.object({
  products: z.array(nodebitsProductRawSchema),
  total: z.number()
})

export type NodebitsShopRaw = z.infer<typeof nodebitsShopRawSchema>
export type NodebitsProductRaw = z.infer<typeof nodebitsProductRawSchema>
export type NodebitsShopsResponse = z.infer<typeof nodebitsShopsResponseSchema>
export type NodebitsProductsPage = z.infer<typeof nodebitsProductsPageSchema>
