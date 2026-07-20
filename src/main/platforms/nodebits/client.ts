import { AppError } from '@shared/types/errors'
import { HttpClient } from '../../services/http-client'
import { resolveRequestUserAgent } from '../../utils/request-headers'
import {
  nodebitsProductsPageSchema,
  nodebitsShopsResponseSchema,
  type NodebitsProductRaw,
  type NodebitsShopRaw
} from './zod'

export const NODEBITS_BASE_URL = 'https://www.nodebits.xyz'

export interface NodebitsClientOptions {
  baseUrl?: string
  /** Empty / omit → desktop Chrome UA. */
  userAgent?: string
  http?: HttpClient
}

/** NodeBits client — shops list + products (for shop URL enrichment). */
export class NodebitsClient {
  private readonly baseUrl: string
  private readonly http: HttpClient

  constructor(options: NodebitsClientOptions = {}) {
    this.baseUrl = (options.baseUrl ?? NODEBITS_BASE_URL).replace(/\/$/, '')
    this.http =
      options.http ??
      new HttpClient({
        userAgent: resolveRequestUserAgent(options.userAgent)
      })
  }

  async fetchShops(): Promise<NodebitsShopRaw[]> {
    const url = `${this.baseUrl}/api/shops`
    const { body } = await this.http.getJson(url)
    const parsed = nodebitsShopsResponseSchema.safeParse(body)
    if (!parsed.success) {
      throw new AppError('SCHEMA_VALIDATION', 'nodebits shops failed zod validation', {
        issues: parsed.error.issues.slice(0, 8)
      })
    }
    return parsed.data.shops
  }

  async fetchProductsPage(params: {
    limit: number
    offset: number
  }): Promise<{ products: NodebitsProductRaw[]; total: number }> {
    const qs = new URLSearchParams({
      limit: String(params.limit),
      offset: String(params.offset)
    })
    const url = `${this.baseUrl}/api/products?${qs.toString()}`
    const { body } = await this.http.getJson(url)
    const parsed = nodebitsProductsPageSchema.safeParse(body)
    if (!parsed.success) {
      throw new AppError('SCHEMA_VALIDATION', 'nodebits products page failed zod validation', {
        issues: parsed.error.issues.slice(0, 8)
      })
    }
    return { products: parsed.data.products, total: parsed.data.total }
  }
}
