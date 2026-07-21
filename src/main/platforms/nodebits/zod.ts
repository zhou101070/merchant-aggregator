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

export type NodebitsShopRaw = z.infer<typeof nodebitsShopRawSchema>
export type NodebitsShopsResponse = z.infer<typeof nodebitsShopsResponseSchema>
