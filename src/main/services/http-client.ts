import { AppError } from '@shared/types/errors'
import { RATE_LIMITS } from '@shared/constants'
import { createLogger } from '../utils/logger'
import { isTransientNetworkError, mainFetch, mergeAbortSignals } from '../utils/main-fetch'
import {
  browserJsonGetHeaders,
  resolveRequestUserAgent
} from '../utils/request-headers'
import { getHostLimiter, hostKey, parseRetryAfterMs, sleep } from './rate-limiter'

const log = createLogger('http')

export interface HttpClientOptions {
  /** Empty / omit → desktop Chrome UA via resolveRequestUserAgent. */
  userAgent?: string
  timeoutMs?: number
  maxRetries?: number
  minIntervalMs?: number
}

export interface HttpGetResult {
  status: number
  body: unknown
  text: string
}

export class HttpClient {
  private readonly timeoutMs: number
  private readonly maxRetries: number
  private readonly minIntervalMs: number
  private readonly userAgent: string

  constructor(options: HttpClientOptions = {}) {
    this.userAgent = resolveRequestUserAgent(options.userAgent)
    this.timeoutMs = options.timeoutMs ?? RATE_LIMITS.requestTimeoutMs
    this.maxRetries = options.maxRetries ?? RATE_LIMITS.maxRetries
    this.minIntervalMs = options.minIntervalMs ?? RATE_LIMITS.priceaiMerchantsIntervalMs.default
  }

  async getJson(url: string, signal?: AbortSignal): Promise<HttpGetResult> {
    let attempt = 0
    let lastError: unknown
    const host = hostKey(url)
    const limiter = getHostLimiter(this.minIntervalMs)

    while (attempt <= this.maxRetries) {
      attempt += 1
      try {
        await limiter.waitTurn(host, signal)
      } catch (err) {
        if (signal?.aborted) throw new AppError('CANCELLED', 'request cancelled')
        throw err
      }
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), this.timeoutMs)
      const requestSignal = mergeAbortSignals(signal, controller.signal)
      try {
        const res = await mainFetch(url, {
          method: 'GET',
          headers: browserJsonGetHeaders({ userAgent: this.userAgent }),
          signal: requestSignal
        })

        const text = await res.text()
        if (res.status === 429) {
          const retryAfterMs =
            parseRetryAfterMs(res.headers.get('retry-after')) ?? RATE_LIMITS.rateLimitFallbackMs
          limiter.defer(host, retryAfterMs)
          throw new AppError('RATE_LIMIT', `rate limited: ${url}`, {
            status: 429,
            retryAfterMs
          })
        }
        if (res.status >= 500) {
          const retryAfterMs = parseRetryAfterMs(res.headers.get('retry-after'))
          if (retryAfterMs != null) limiter.defer(host, retryAfterMs)
          throw new AppError('NETWORK', `server error ${res.status}: ${url}`, {
            status: res.status,
            retryAfterMs
          })
        }
        if (!res.ok) {
          throw new AppError('NETWORK', `HTTP ${res.status}: ${url}`, {
            status: res.status,
            body: text.slice(0, 500)
          })
        }

        let body: unknown
        try {
          body = text ? JSON.parse(text) : null
        } catch {
          throw new AppError('SCHEMA_VALIDATION', `invalid JSON from ${url}`, {
            snippet: text.slice(0, 200)
          })
        }

        return { status: res.status, body, text }
      } catch (err) {
        lastError = err
        const isAbort =
          err instanceof Error && (err.name === 'AbortError' || /aborted/i.test(err.message))
        const appErr =
          err instanceof AppError
            ? err
            : new AppError(
                isAbort ? (signal?.aborted ? 'CANCELLED' : 'TIMEOUT') : 'NETWORK',
                isAbort ? (signal?.aborted ? 'request cancelled' : 'request timeout') : String(err)
              )

        if (appErr.code === 'CANCELLED') throw appErr
        if (attempt > this.maxRetries || !isRetryableRequestError(err, appErr)) {
          throw appErr
        }

        const backoff = Math.min(8000, 800 * 2 ** (attempt - 1))
        log.warn('request failed, retrying', {
          url,
          attempt,
          backoff,
          code: appErr.code,
          message: appErr.message
        })
        try {
          await sleep(backoff, signal)
        } catch (sleepError) {
          if (signal?.aborted) throw new AppError('CANCELLED', 'request cancelled')
          throw sleepError
        }
      } finally {
        clearTimeout(timer)
      }
    }

    throw lastError instanceof AppError
      ? lastError
      : new AppError('INTERNAL', 'http get exhausted retries')
  }
}

function isRetryableRequestError(source: unknown, appErr: AppError): boolean {
  if (appErr.code === 'TIMEOUT') return true
  if (appErr.code !== 'NETWORK') return false
  const status = (appErr.details as { status?: unknown } | undefined)?.status
  if (typeof status === 'number') return status >= 500
  if (!(source instanceof AppError)) return true
  return isTransientNetworkError(source)
}
