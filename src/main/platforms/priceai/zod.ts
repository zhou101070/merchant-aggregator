import { z } from 'zod'

export const priceaiMerchantRawSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    storeName: z.string().nullish(),
    host: z.string().nullish(),
    shopUrl: z.string().nullish(),
    entryUrl: z.string().nullish(),
    sourceId: z.string().nullish(),
    sourceName: z.string().nullish(),
    collectorKind: z.string().nullish(),
    healthStatus: z.string().nullish(),
    offerCount: z.number().nullish(),
    inStockCount: z.number().nullish(),
    outOfStockCount: z.number().nullish(),
    productCount: z.number().nullish(),
    platformCount: z.number().nullish(),
    platforms: z.array(z.string()).nullish(),
    productTypes: z.array(z.string()).nullish(),
    representativeProduct: z.string().nullish(),
    representativeOfferTitle: z.string().nullish(),
    representativePrice: z.number().nullish(),
    representativeCurrency: z.string().nullish(),
    lowestHitCount: z.number().nullish(),
    warrantyLowestHitCount: z.number().nullish(),
    riskFeedbackCount: z.number().nullish(),
    hasPlatformAftersalesMechanism: z.boolean().nullish(),
    shopCreatedAt: z.string().nullish(),
    includedAt: z.string().nullish(),
    lastSuccessAt: z.string().nullish(),
    latestSeenAt: z.string().nullish(),
    consecutiveFailures: z.number().nullish(),
    observationStartedAt: z.string().nullish()
  })
  .passthrough()

export const priceaiMerchantsPageSchema = z.object({
  rows: z.array(priceaiMerchantRawSchema),
  total: z.number(),
  message: z.string().nullable().optional(),
  // Live API may omit this field; treat missing as healthy.
  degraded: z.boolean().optional().default(false),
  generatedAt: z.string().nullable().optional(),
  limited: z.boolean(),
  limit: z.number(),
  offset: z.number()
})

export type PriceaiMerchantsPageParsed = z.infer<typeof priceaiMerchantsPageSchema>
export type PriceaiMerchantRawParsed = z.infer<typeof priceaiMerchantRawSchema>
