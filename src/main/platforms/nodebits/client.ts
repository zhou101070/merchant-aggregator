import { AppError } from '@shared/types/errors'
import { RATE_LIMITS } from '@shared/constants'
import { HttpClient } from '../../services/http-client'
import { getHostLimiter, hostKey } from '../../services/rate-limiter'
import { createLogger } from '../../utils/logger'
import { mainFetch } from '../../utils/main-fetch'
import {
  browserDocumentHeaders,
  resolveRequestUserAgent
} from '../../utils/request-headers'
import { nodebitsShopGoUrl, parseNodebitsGoTargetHtml } from './parse-go'
import { nodebitsShopsResponseSchema, type NodebitsShopRaw } from './zod'

const log = createLogger('nodebits:client')

export const NODEBITS_BASE_URL = 'https://www.nodebits.xyz'

export interface NodebitsClientOptions {
  baseUrl?: string
  /** Empty / omit → desktop Chrome UA. */
  userAgent?: string
  http?: HttpClient
  timeoutMs?: number
}

/** NodeBits client — shops list + /go intermediate page for external shop URL. */
export class NodebitsClient {
  private readonly baseUrl: string
  private readonly http: HttpClient
  private readonly userAgent: string
  private readonly timeoutMs: number
  private readonly host: string
  private readonly minIntervalMs: number

  constructor(options: NodebitsClientOptions = {}) {
    this.baseUrl = (options.baseUrl ?? NODEBITS_BASE_URL).replace(/\/$/, '')
    this.userAgent = resolveRequestUserAgent(options.userAgent)
    this.timeoutMs = options.timeoutMs ?? RATE_LIMITS.requestTimeoutMs
    this.host = hostKey(this.baseUrl)
    this.minIntervalMs = RATE_LIMITS.priceaiMerchantsIntervalMs.default
    this.http =
      options.http ??
      new HttpClient({
        userAgent: this.userAgent,
        timeoutMs: this.timeoutMs
      })
  }

  /** GET /api/shops — merchant ids + names (no external URLs). */
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

  /**
   * Resolve external shop URL via intermediate page:
   *   /go?type=shop&id={shopId}
   * Target is the "不想等待,直接前往" link (or HTTP Location / auto-redirect).
   * Returns null on network/CF/parse miss (caller drops or skips).
   */
  async fetchShopGoTarget(
    shopId: string,
    signal?: AbortSignal
  ): Promise<string | null> {
    const id = shopId.trim()
    if (!id) return null
    try {
      await getHostLimiter(this.minIntervalMs).waitTurn(this.host, signal)
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        throw new AppError('CANCELLED', 'nodebits go fetch cancelled')
      }
      throw err
    }
    const url = nodebitsShopGoUrl(this.baseUrl, id)
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    const onAbort = (): void => controller.abort()
    if (signal) {
      if (signal.aborted) {
        clearTimeout(timer)
        throw new AppError('CANCELLED', 'nodebits go fetch cancelled')
      }
      signal.addEventListener('abort', onAbort, { once: true })
    }
    try {
      const res = await mainFetch(url, {
        method: 'GET',
        redirect: 'manual',
        headers: browserDocumentHeaders({ userAgent: this.userAgent }),
        signal: controller.signal
      })

      // Immediate redirect to external shop
      if (res.status >= 300 && res.status < 400) {
        const loc = res.headers.get('location')
        if (loc) {
          try {
            const abs = new URL(loc, this.baseUrl).href
            if (!/\.nodebits\.xyz$/i.test(new URL(abs).hostname)) {
              return abs
            }
          } catch {
            /* fall through to body */
          }
        }
      }

      if (res.status === 429) {
        throw new AppError('RATE_LIMIT', `rate limited: ${url}`, { status: 429 })
      }
      if (res.status >= 500) {
        throw new AppError('NETWORK', `server error ${res.status}: ${url}`, {
          status: res.status
        })
      }
      if (!res.ok && res.status !== 200) {
        // 403 CF challenge etc.
        log.info('go page non-ok', { shopId: id, status: res.status })
        return null
      }

      const html = await res.text()
      const target = parseNodebitsGoTargetHtml(html, { baseUrl: this.baseUrl })
      if (!target) {
        log.info('go page parse miss', {
          shopId: id,
          status: res.status,
          snippet: html.slice(0, 120).replace(/\s+/g, ' ')
        })
      }
      return target
    } catch (err) {
      if (err instanceof AppError && err.code === 'CANCELLED') throw err
      if (err instanceof Error && (err.name === 'AbortError' || /aborted/i.test(err.message))) {
        if (signal?.aborted) {
          throw new AppError('CANCELLED', 'nodebits go fetch cancelled')
        }
        throw new AppError('TIMEOUT', `nodebits go timeout: ${url}`)
      }
      if (err instanceof AppError) throw err
      log.info('go page fetch failed', {
        shopId: id,
        error: err instanceof Error ? err.message : String(err)
      })
      return null
    } finally {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
    }
  }
}
