import { DEFAULT_PRICEAI_UA } from '@shared/constants'
import { AppError } from '@shared/types/errors'
import { HttpClient } from '../../services/http-client'
import { priceaiMerchantsPageSchema } from './zod'
import type { PriceaiMerchantsPageParsed } from './zod'

export const PRICEAI_BASE_URL = 'https://priceai.cc'

export interface PriceaiClientOptions {
  baseUrl?: string
  userAgent?: string
  http?: HttpClient
}

/** PriceAI client — merchants list only. */
export class PriceaiClient {
  private readonly baseUrl: string
  private readonly http: HttpClient

  constructor(options: PriceaiClientOptions = {}) {
    this.baseUrl = (options.baseUrl ?? PRICEAI_BASE_URL).replace(/\/$/, '')
    this.http =
      options.http ??
      new HttpClient({
        userAgent: options.userAgent ?? DEFAULT_PRICEAI_UA
      })
  }

  async fetchMerchantsPage(params: {
    limit: number
    offset: number
  }): Promise<PriceaiMerchantsPageParsed> {
    const qs = new URLSearchParams({
      limit: String(params.limit),
      offset: String(params.offset)
    })
    const url = `${this.baseUrl}/api/merchants?${qs.toString()}`
    const { body } = await this.http.getJson(url)
    const parsed = priceaiMerchantsPageSchema.safeParse(body)
    if (!parsed.success) {
      throw new AppError('SCHEMA_VALIDATION', 'merchants page failed zod validation', {
        issues: parsed.error.issues.slice(0, 8)
      })
    }
    if (parsed.data.degraded) {
      throw new AppError('DEGRADED', 'PriceAI merchants response marked degraded', {
        offset: params.offset
      })
    }
    return parsed.data
  }
}
