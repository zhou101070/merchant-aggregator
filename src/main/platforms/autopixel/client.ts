import { AppError } from '@shared/types/errors'
import { appErrorFromAbort, isAbortError } from '../../utils/abort'
import { createLogger } from '../../utils/logger'
import { fetchErrorDetails, mainFetch } from '../../utils/main-fetch'
import { getHostLimiter, hostKey } from '../../services/rate-limiter'
import {
  browserCorsApiHeaders,
  browserDocumentHeaders,
  browserScriptHeaders,
  resolveRequestUserAgent
} from '../../utils/request-headers'

const log = createLogger('autopixel')

export const AUTOPIXEL_SOURCE_ID = 'autopixel'
export const AUTOPIXEL_PLATFORM_ID = 'autopixel'

/** Next server action name used by AutoPixel wholesale catalog. */
export const AUTOPIXEL_WHOLESALE_ACTION = 'fetchWholesaleProductsAction'

const ACTION_ID_RE = new RegExp(
  String.raw`\("([0-9a-f]{40,})",[^)]{0,200}"${AUTOPIXEL_WHOLESALE_ACTION}"\)`
)
const ACTION_ID_RE_ALT = new RegExp(
  String.raw`createServerReference\)\("([0-9a-f]{40,})"[^)]{0,200}${AUTOPIXEL_WHOLESALE_ACTION}`
)

export interface AutopixelProduct {
  id?: number | string | null
  name?: string | null
  wholesale_name?: string | null
  category?: string | null
  description?: string | null
  wholesale_description?: string | null
  price?: number | string | null
  wholesale_price?: number | string | null
  stock_count?: number | string | null
  is_active?: boolean | null
  is_wholesale_active?: boolean | null
  is_archived?: boolean | null
  image_url?: string | null
  delivery_type?: string | null
  badge?: string | null
  [key: string]: unknown
}

export interface AutopixelShopRef {
  /** Normalized host */
  host: string
  /** First path segment shop slug (e.g. blackcat) */
  slug: string
  /** https://{host}/{slug} */
  shopPageUrl: string
  /** origin */
  baseUrl: string
  /** Persist token: host/slug */
  token: string
}

/**
 * Parse AutoPixel shop from URL or stored token `host/slug`.
 * Path must have a non-empty first segment (not multi-tenant root).
 */
export function parseAutopixelShopRef(opts: {
  shopUrl?: string | null
  entryUrl?: string | null
  baseUrl?: string | null
  token?: string | null
  host?: string | null
}): AutopixelShopRef | null {
  for (const raw of [opts.shopUrl, opts.entryUrl, opts.baseUrl]) {
    const fromUrl = parseFromUrl(raw)
    if (fromUrl) return fromUrl
  }
  const tok = (opts.token || '').trim().toLowerCase().replace(/^\/+|\/+$/g, '')
  if (tok.includes('/')) {
    const slash = tok.indexOf('/')
    const host = tok.slice(0, slash).replace(/\.$/, '')
    const slug = tok.slice(slash + 1).split('/')[0]?.replace(/\/+$/, '') || ''
    if (host.includes('.') && slug && !slug.includes('.')) {
      return {
        host,
        slug,
        baseUrl: `https://${host}`,
        shopPageUrl: `https://${host}/${slug}`,
        token: `${host}/${slug}`
      }
    }
  }
  return null
}

function parseFromUrl(raw: string | null | undefined): AutopixelShopRef | null {
  if (!raw?.trim()) return null
  try {
    const u = new URL(raw.includes('://') ? raw.trim() : `https://${raw.trim()}`)
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null
    const host = u.hostname.toLowerCase().replace(/\.$/, '')
    if (!host.includes('.')) return null
    const parts = u.pathname.split('/').filter(Boolean)
    const slug = parts[0]?.trim()
    if (!slug) return null
    // Skip obvious non-shop first segments
    if (/^(api|_next|static|admin|login|orders|cart)$/i.test(slug)) return null
    return {
      host,
      slug,
      baseUrl: u.origin,
      shopPageUrl: `${u.origin}/${slug}`,
      token: `${host}/${slug}`
    }
  } catch {
    return null
  }
}

export function extractWholesaleActionId(jsOrHtml: string): string | null {
  const m = jsOrHtml.match(ACTION_ID_RE) || jsOrHtml.match(ACTION_ID_RE_ALT)
  return m?.[1] ?? null
}

/** Parse Next.js flight / text-x-component body for action result payload. */
export function parseFlightActionPayload(text: string): unknown {
  const lines = text.split('\n')
  // Prefer numbered payload lines after the header (1:{...})
  for (const line of lines) {
    const m = line.match(/^(\d+):(.*)$/)
    if (!m) continue
    const body = m[2]
    if (!body.startsWith('{') && !body.startsWith('[')) continue
    try {
      const parsed = JSON.parse(body) as unknown
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        const o = parsed as Record<string, unknown>
        if ('success' in o || 'data' in o) return parsed
      }
    } catch {
      /* try next line */
    }
  }
  // Fallback: whole body JSON
  try {
    return JSON.parse(text) as unknown
  } catch {
    throw new AppError('SCHEMA_VALIDATION', 'autopixel non-JSON flight payload', {
      snippet: text.slice(0, 200),
      notFamily: true,
      platformId: AUTOPIXEL_PLATFORM_ID
    })
  }
}

export class AutopixelClient {
  private readonly ua: string
  private readonly minIntervalMs: number
  private readonly host: string
  private readonly signal?: AbortSignal

  constructor(
    private readonly ref: AutopixelShopRef,
    options?: { userAgent?: string; minIntervalMs?: number; signal?: AbortSignal }
  ) {
    this.ua = resolveRequestUserAgent(options?.userAgent)
    this.minIntervalMs = options?.minIntervalMs ?? 500
    this.host = hostKey(ref.baseUrl)
    this.signal = options?.signal
  }

  private async waitTurn(): Promise<void> {
    try {
      await getHostLimiter(this.minIntervalMs).waitTurn(this.host, this.signal)
    } catch (err) {
      if (isAbortError(err)) throw appErrorFromAbort(this.signal, 'autopixel scrape')
      throw err
    }
  }

  private async getText(url: string, headers: Record<string, string>): Promise<string> {
    await this.waitTurn()
    let res: Response
    try {
      res = await mainFetch(url, { method: 'GET', headers, signal: this.signal })
    } catch (err) {
      if (err instanceof AppError) throw err
      if (isAbortError(err)) throw appErrorFromAbort(this.signal, 'autopixel scrape')
      throw new AppError('NETWORK', `autopixel fetch failed: ${String(err)}`, {
        url,
        ...fetchErrorDetails(err)
      })
    }
    const text = await res.text()
    if (!res.ok) {
      throw new AppError('NETWORK', `autopixel HTTP ${res.status}`, {
        url,
        status: res.status,
        snippet: text.slice(0, 200)
      })
    }
    return text
  }

  /** Discover Next server action id for wholesale product list from page chunks. */
  async discoverWholesaleActionId(): Promise<string> {
    const html = await this.getText(
      this.ref.shopPageUrl,
      browserDocumentHeaders({ userAgent: this.ua })
    )
    const fromHtml = extractWholesaleActionId(html)
    if (fromHtml) return fromHtml

    if (!html.includes(AUTOPIXEL_WHOLESALE_ACTION) && !html.includes('/_next/static/chunks/')) {
      throw new AppError('NOT_FOUND', 'autopixel: page is not AutoPixel wholesale family', {
        url: this.ref.shopPageUrl,
        notFamily: true,
        platformId: AUTOPIXEL_PLATFORM_ID
      })
    }

    const chunks = [...new Set(html.match(/\/_next\/static\/chunks\/[^"'\\s>]+\.js/g) ?? [])]
    for (const path of chunks) {
      if (this.signal?.aborted) throw new AppError('CANCELLED', 'autopixel scrape cancelled')
      const url = path.startsWith('http') ? path : `${this.ref.baseUrl}${path}`
      let js: string
      try {
        js = await this.getText(
          url,
          browserScriptHeaders({ userAgent: this.ua, referer: this.ref.shopPageUrl })
        )
      } catch {
        continue
      }
      const id = extractWholesaleActionId(js)
      if (id) {
        log.info('discovered wholesale action', { host: this.ref.host, slug: this.ref.slug, id })
        return id
      }
    }

    throw new AppError('NOT_FOUND', 'autopixel: fetchWholesaleProductsAction not found', {
      url: this.ref.shopPageUrl,
      notFamily: true,
      platformId: AUTOPIXEL_PLATFORM_ID
    })
  }

  async fetchWholesaleProducts(actionId: string): Promise<AutopixelProduct[]> {
    await this.waitTurn()
    const url = this.ref.shopPageUrl
    const headers = browserCorsApiHeaders({
      userAgent: this.ua,
      origin: this.ref.baseUrl,
      referer: this.ref.shopPageUrl,
      contentType: 'text/plain;charset=UTF-8'
    })
    headers.Accept = 'text/x-component'
    headers['Next-Action'] = actionId

    let res: Response
    try {
      res = await mainFetch(url, {
        method: 'POST',
        headers,
        body: '[]',
        signal: this.signal
      })
    } catch (err) {
      if (err instanceof AppError) throw err
      if (isAbortError(err)) throw appErrorFromAbort(this.signal, 'autopixel scrape')
      throw new AppError('NETWORK', `autopixel action fetch failed: ${String(err)}`, {
        url,
        ...fetchErrorDetails(err)
      })
    }

    const text = await res.text()
    if (!res.ok) {
      throw new AppError('NETWORK', `autopixel action HTTP ${res.status}`, {
        url,
        status: res.status,
        snippet: text.slice(0, 200)
      })
    }

    const payload = parseFlightActionPayload(text) as {
      success?: boolean
      data?: AutopixelProduct[] | null
      error?: string
    }

    if (payload && typeof payload === 'object' && payload.success === false) {
      throw new AppError('NETWORK', payload.error || 'autopixel action success=false', {
        url,
        notFamily: true,
        platformId: AUTOPIXEL_PLATFORM_ID
      })
    }

    const data = payload?.data
    if (!Array.isArray(data)) {
      throw new AppError('SCHEMA_VALIDATION', 'autopixel products payload is not an array', {
        url,
        notFamily: true,
        platformId: AUTOPIXEL_PLATFORM_ID
      })
    }
    return data
  }
}
