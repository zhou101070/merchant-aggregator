import { AppError } from '@shared/types/errors'
import { createLogger } from '../../utils/logger'
import { fetchErrorDetails, mainFetch } from '../../utils/main-fetch'
import { IntervalLimiter } from '../../services/rate-limiter'
import { browserJsonGetHeaders, resolveRequestUserAgent } from '../../utils/request-headers'

const log = createLogger('yiciyuan')

export const YICIYUAN_SOURCE_ID = 'yiciyuan'

export interface YiciyuanCategory {
  id?: number | string | null
  name?: string | null
  icon?: string | null
  status?: number | null
  hide?: number | null
  commodity_count?: number | null
  [key: string]: unknown
}

export interface YiciyuanCommodity {
  id?: number | string | null
  name?: string | null
  cover?: string | null
  status?: number | null
  delivery_way?: number | null
  price?: number | string | null
  user_price?: number | string | null
  hide?: number | null
  inventory_hidden?: number | null
  recommend?: number | null
  category_id?: number | string | null
  stock?: number | null
  shared_id?: number | null
  order_sold?: number | null
  category?: YiciyuanCategory | null
  stock_state?: number | null
  [key: string]: unknown
}

interface Envelope<T> {
  code?: number
  msg?: string
  data?: T
}

export function normalizeYiciyuanHost(host: string): string {
  return host.trim().toLowerCase().replace(/\.$/, '')
}

/** Resolve site origin from merchant URLs or https://{host}. */
export function resolveYiciyuanBaseUrl(opts: {
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
  if (host) return `https://${normalizeYiciyuanHost(host)}`
  throw new AppError('INVALID_URL', 'yiciyuan base URL unresolved', { host: opts.host })
}

export class YiciyuanClient {
  readonly baseUrl: string
  private readonly ua: string
  private readonly limiter: IntervalLimiter

  constructor(baseUrl: string, options?: { userAgent?: string; minIntervalMs?: number }) {
    this.baseUrl = baseUrl.replace(/\/$/, '')
    this.ua = resolveRequestUserAgent(options?.userAgent)
    this.limiter = new IntervalLimiter(options?.minIntervalMs ?? 500)
  }

  private async getJson<T>(path: string): Promise<T> {
    await this.limiter.waitTurn()
    const url = `${this.baseUrl}${path.startsWith('/') ? path : `/${path}`}`
    const headers = browserJsonGetHeaders({
      userAgent: this.ua,
      origin: this.baseUrl,
      referer: `${this.baseUrl}/`,
      fetchSite: 'same-origin'
    })

    let res: Response
    try {
      res = await mainFetch(url, { method: 'GET', headers })
    } catch (err) {
      throw new AppError('NETWORK', `yiciyuan fetch failed: ${String(err)}`, {
        path,
        url,
        ...fetchErrorDetails(err)
      })
    }

    const text = await res.text()
    if (!text.trim()) {
      throw new AppError('NETWORK', 'yiciyuan empty response body', {
        path,
        status: res.status
      })
    }

    if (!res.ok) {
      throw new AppError('NETWORK', `yiciyuan HTTP ${res.status}`, {
        path,
        status: res.status,
        snippet: text.slice(0, 200)
      })
    }

    let json: Envelope<T>
    try {
      json = JSON.parse(text) as Envelope<T>
    } catch {
      throw new AppError('SCHEMA_VALIDATION', 'yiciyuan non-JSON response body', {
        path,
        snippet: text.slice(0, 200),
        notFamily: true,
        platformId: YICIYUAN_SOURCE_ID
      })
    }

    if (json.code !== 200) {
      throw new AppError('SCHEMA_VALIDATION', json.msg || `yiciyuan code=${json.code}`, {
        path,
        code: json.code,
        notFamily: true,
        platformId: YICIYUAN_SOURCE_ID
      })
    }
    if (json.data != null && !Array.isArray(json.data) && typeof json.data !== 'object') {
      throw new AppError('SCHEMA_VALIDATION', 'yiciyuan unexpected data shape', {
        path,
        notFamily: true,
        platformId: YICIYUAN_SOURCE_ID
      })
    }
    return json.data as T
  }

  /** Category tree (includes synthetic "recommend"). */
  async indexData(): Promise<YiciyuanCategory[]> {
    const data = await this.getJson<YiciyuanCategory[]>('/user/api/index/data')
    if (!Array.isArray(data)) {
      throw new AppError('NETWORK', 'yiciyuan categories payload is not an array', {
        baseUrl: this.baseUrl
      })
    }
    log.info('categories ok', { baseUrl: this.baseUrl, count: data.length })
    return data
  }

  /** Full commodity catalog (one shot; no pagination on this API). */
  async indexCommodity(): Promise<YiciyuanCommodity[]> {
    const data = await this.getJson<YiciyuanCommodity[]>('/user/api/index/commodity')
    if (!Array.isArray(data)) {
      throw new AppError('NETWORK', 'yiciyuan commodities payload is not an array', {
        baseUrl: this.baseUrl
      })
    }
    return data
  }
}
