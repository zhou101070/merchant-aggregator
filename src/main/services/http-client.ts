import { AppError } from '@shared/types/errors'
import { RATE_LIMITS } from '@shared/constants'
import { createLogger } from '../utils/logger'
import { sleep } from './rate-limiter'

const log = createLogger('http')

export interface HttpClientOptions {
  userAgent: string
  timeoutMs?: number
  maxRetries?: number
}

export interface HttpGetResult {
  status: number
  body: unknown
  text: string
}

export class HttpClient {
  private readonly timeoutMs: number
  private readonly maxRetries: number
  private readonly userAgent: string

  constructor(options: HttpClientOptions) {
    this.userAgent = options.userAgent
    this.timeoutMs = options.timeoutMs ?? RATE_LIMITS.requestTimeoutMs
    this.maxRetries = options.maxRetries ?? RATE_LIMITS.maxRetries
  }

  async getJson(url: string): Promise<HttpGetResult> {
    let attempt = 0
    let lastError: unknown

    while (attempt <= this.maxRetries) {
      attempt += 1
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), this.timeoutMs)
      try {
        const res = await fetch(url, {
          method: 'GET',
          headers: {
            Accept: 'application/json',
            'User-Agent': this.userAgent
          },
          signal: controller.signal
        })

        const text = await res.text()
        if (res.status === 429) {
          throw new AppError('RATE_LIMIT', `rate limited: ${url}`, { status: 429 })
        }
        if (res.status >= 500) {
          throw new AppError('NETWORK', `server error ${res.status}: ${url}`, {
            status: res.status
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
                isAbort ? 'TIMEOUT' : 'NETWORK',
                isAbort ? 'request timeout' : String(err)
              )

        if (attempt > this.maxRetries) {
          throw appErr
        }

        const backoff = Math.min(8000, 400 * 2 ** (attempt - 1))
        log.warn('request failed, retrying', {
          url,
          attempt,
          backoff,
          code: appErr.code,
          message: appErr.message
        })
        await sleep(backoff)
      } finally {
        clearTimeout(timer)
      }
    }

    throw lastError instanceof AppError
      ? lastError
      : new AppError('INTERNAL', 'http get exhausted retries')
  }
}
