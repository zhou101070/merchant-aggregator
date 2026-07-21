import { AppError } from '@shared/types/errors'
import { createLogger } from '../../utils/logger'
import { fetchErrorDetails, mainFetch } from '../../utils/main-fetch'
import { getHostLimiter, hostKey } from '../../services/rate-limiter'
import { browserJsonGetHeaders, resolveRequestUserAgent } from '../../utils/request-headers'

const log = createLogger('dujiao')

export const DUJIAO_SOURCE_ID = 'dujiao'

export interface DujiaoI18n {
  'zh-CN'?: string
  'zh-TW'?: string
  'en-US'?: string
  [key: string]: string | undefined
}

export interface DujiaoSku {
  id?: number
  sku_code?: string | null
  spec_values?: DujiaoI18n | Record<string, string> | null
  price_amount?: string | number | null
  manual_stock_available?: number | null
  manual_stock_total?: number | null
  manual_stock_sold?: number | null
  auto_stock_available?: number | null
  upstream_stock?: number | null
  is_active?: boolean | null
  [key: string]: unknown
}

export interface DujiaoCategory {
  id?: number
  slug?: string | null
  name?: DujiaoI18n | null
  [key: string]: unknown
}

export interface DujiaoProduct {
  id?: number
  category_id?: number | null
  slug?: string | null
  title?: DujiaoI18n | null
  description?: DujiaoI18n | null
  content?: DujiaoI18n | null
  price_amount?: string | number | null
  images?: string[] | null
  tags?: string[] | null
  fulfillment_type?: string | null
  manual_stock_available?: number | null
  auto_stock_available?: number | null
  stock_status?: string | null
  is_sold_out?: boolean | null
  category?: DujiaoCategory | null
  skus?: DujiaoSku[] | null
  [key: string]: unknown
}

export interface DujiaoPublicConfig {
  app_version?: string | null
  currency?: string | null
  brand?: {
    site_name?: string | null
    site_url?: string | null
    [key: string]: unknown
  } | null
  [key: string]: unknown
}

interface Envelope<T> {
  status_code?: number
  msg?: string
  data?: T
}

export function normalizeDujiaoHost(host: string): string {
  return host.trim().toLowerCase().replace(/\.$/, '')
}

/** Resolve site origin from merchant URLs or https://{host}. */
export function resolveDujiaoBaseUrl(opts: {
  host?: string | null
  shopUrl?: string | null
  entryUrl?: string | null
  baseUrl?: string | null
}): string {
  if (opts.baseUrl?.trim()) {
    try {
      return new URL(opts.baseUrl.trim()).origin
    } catch {
      /* fall through */
    }
  }
  for (const raw of [opts.entryUrl, opts.shopUrl]) {
    if (!raw?.trim()) continue
    try {
      const u = new URL(raw.includes('://') ? raw : `https://${raw}`)
      if (u.protocol === 'http:' || u.protocol === 'https:') return u.origin
    } catch {
      /* continue */
    }
  }
  const host = opts.host?.trim()
  if (host) return `https://${normalizeDujiaoHost(host)}`
  throw new AppError('INVALID_URL', 'dujiao base URL unresolved', { host: opts.host })
}

export class DujiaoClient {
  readonly baseUrl: string
  private readonly ua: string
  private readonly minIntervalMs: number
  private readonly host: string
  private readonly signal?: AbortSignal

  constructor(
    baseUrl: string,
    options?: { userAgent?: string; minIntervalMs?: number; signal?: AbortSignal }
  ) {
    this.baseUrl = baseUrl.replace(/\/$/, '')
    this.ua = resolveRequestUserAgent(options?.userAgent)
    this.minIntervalMs = options?.minIntervalMs ?? 500
    this.host = hostKey(this.baseUrl)
    this.signal = options?.signal
  }

  private async getJson<T>(path: string): Promise<T> {
    try {
      await getHostLimiter(this.minIntervalMs).waitTurn(this.host, this.signal)
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        throw new AppError('CANCELLED', 'dujiao scrape cancelled')
      }
      throw err
    }
    const url = `${this.baseUrl}${path.startsWith('/') ? path : `/${path}`}`
    const headers = browserJsonGetHeaders({
      userAgent: this.ua,
      origin: this.baseUrl,
      // Catalog SPA path is /products (not site root)
      referer: `${this.baseUrl}/products`,
      fetchSite: 'same-origin'
    })

    let res: Response
    try {
      res = await mainFetch(url, { method: 'GET', headers, signal: this.signal })
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        throw new AppError('CANCELLED', 'dujiao scrape cancelled')
      }
      throw new AppError('NETWORK', `dujiao fetch failed: ${String(err)}`, {
        path,
        url,
        ...fetchErrorDetails(err)
      })
    }

    const text = await res.text()
    if (!text.trim()) {
      throw new AppError('NETWORK', 'dujiao empty response body', {
        path,
        status: res.status
      })
    }

    if (!res.ok) {
      throw new AppError('NETWORK', `dujiao HTTP ${res.status}`, {
        path,
        status: res.status,
        snippet: text.slice(0, 200)
      })
    }

    let json: Envelope<T>
    try {
      json = JSON.parse(text) as Envelope<T>
    } catch {
      throw new AppError('SCHEMA_VALIDATION', 'dujiao non-JSON response body', {
        path,
        snippet: text.slice(0, 200),
        notFamily: true,
        platformId: DUJIAO_SOURCE_ID
      })
    }

    if (json.status_code !== 0) {
      throw new AppError(
        'SCHEMA_VALIDATION',
        json.msg || `dujiao status_code=${json.status_code}`,
        {
          path,
          status_code: json.status_code,
          notFamily: true,
          platformId: DUJIAO_SOURCE_ID
        }
      )
    }
    return json.data as T
  }

  async publicConfig(): Promise<DujiaoPublicConfig> {
    const data = await this.getJson<DujiaoPublicConfig>('/api/v1/public/config')
    log.info('config ok', {
      baseUrl: this.baseUrl,
      version: data?.app_version ?? null,
      site: data?.brand?.site_name ?? null
    })
    return data ?? {}
  }

  async publicProducts(): Promise<DujiaoProduct[]> {
    const data = await this.getJson<DujiaoProduct[] | { list?: DujiaoProduct[] }>(
      '/api/v1/public/products'
    )
    if (Array.isArray(data)) return data
    if (data && Array.isArray(data.list)) return data.list
    throw new AppError('NETWORK', 'dujiao products payload is not an array', {
      baseUrl: this.baseUrl
    })
  }

  async publicProductBySlug(slug: string): Promise<DujiaoProduct> {
    const enc = encodeURIComponent(slug)
    return this.getJson<DujiaoProduct>(`/api/v1/public/products/${enc}`)
  }
}
