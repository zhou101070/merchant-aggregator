import { randomBytes } from 'node:crypto'
import { AppError } from '@shared/types/errors'
import type { ShopSiteProfile } from '@shared/platforms/shop-types'
import { resolveShopApiEndpoints, shopRootUrl } from '@shared/platforms/shop-types'
import { SHOP_API_LIMITS } from '@shared/constants'
import { createLogger } from '../../utils/logger'
import { fetchErrorDetails, mainFetch } from '../../utils/main-fetch'
import { getShopNodeLimiter } from '../../services/rate-limiter'
import { getProxyCoreService } from '../../services/proxy-core-service'
import {
  browserCorsApiHeaders,
  browserDocumentHeaders,
  resolveRequestUserAgent
} from '../../utils/request-headers'
import { isShopApiChallengeResponse } from './challenge'
import { ShopPageSession } from './browser-session'

const log = createLogger('shopapi')

export function createVisitorId(): string {
  return randomBytes(8).toString('hex')
}

export interface ShopApiShopInfo {
  token: string
  nickname: string | null
  goods_count: number
  goods_type_sort: string[]
  link: string | null
}

export interface ShopApiGoodsItem {
  goods_key: string
  name: string
  price: number | string | null
  market_price?: number | string | null
  link?: string | null
  goods_type?: string | null
  image?: string | null
  description?: string | null
  category?: { id?: number; name?: string } | null
  extend?: { stock_count?: number | null } | null
  user?: { token?: string; nickname?: string } | null
}

/**
 * Parameterized shopApi-family HTTP client.
 * Prefer page-context fetch (real shop tab) so WAF sees browser-like traffic.
 * Fallback: mainFetch with cookie jar (tests / no Electron).
 */
export class ShopApiClient {
  private readonly profile: ShopSiteProfile
  private readonly visitorId: string
  private readonly cookieJar = new Map<string, string>()
  private readonly ua: string
  private readonly minIntervalMs: number
  private readonly signal?: AbortSignal
  private readonly openSystemBrowserOnWaf: boolean
  private pageSession: ShopPageSession | null = null
  /** Prefer in-page fetch after successful browser open */
  private usePageFetch = false

  constructor(
    profile: ShopSiteProfile,
    options?: {
      visitorId?: string
      userAgent?: string
      minIntervalMs?: number
      signal?: AbortSignal
      /** default true；后台自动刷新传 false */
      openSystemBrowserOnWaf?: boolean
    }
  ) {
    this.profile = profile
    this.visitorId = options?.visitorId ?? createVisitorId()
    this.ua = resolveRequestUserAgent(options?.userAgent)
    this.minIntervalMs = options?.minIntervalMs ?? profile.defaultMinIntervalMs
    this.signal = options?.signal
    this.openSystemBrowserOnWaf = options?.openSystemBrowserOnWaf !== false
  }

  private throwIfAborted(): void {
    if (this.signal?.aborted) {
      throw new AppError('CANCELLED', 'shop scrape cancelled', { platformId: this.profile.id })
    }
  }

  /**
   * Per-proxy-node start spacing (shared process-wide).
   * Pinned → only that node; else reserve the free-est known node slot.
   */
  private async waitTurn(): Promise<void> {
    this.throwIfAborted()
    try {
      const limiter = getShopNodeLimiter(this.minIntervalMs)
      const keys = await this.resolveLimiterNodeKeys()
      await limiter.acquire(keys, this.signal)
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        throw new AppError('CANCELLED', 'shop scrape cancelled', { platformId: this.profile.id })
      }
      throw err
    }
    this.throwIfAborted()
  }

  private async resolveLimiterNodeKeys(): Promise<string[]> {
    const core = getProxyCoreService()
    if (!core || core.status().state !== 'running') return []
    const pinned = core.currentPinnedNode()
    if (pinned) return [pinned]
    try {
      return await core.listNodeNamesCached()
    } catch {
      return []
    }
  }

  get baseUrl(): string {
    return this.profile.baseUrl
  }

  get platformId(): string {
    return this.profile.id
  }

  /** Close Chromium shop tab (call after scrape). */
  async dispose(): Promise<void> {
    this.usePageFetch = false
    if (this.pageSession) {
      await this.pageSession.close()
      this.pageSession = null
    }
  }

  private absorbSetCookie(res: Response): void {
    const anyHeaders = res.headers as Headers & { getSetCookie?: () => string[] }
    let list: string[] = []
    if (typeof anyHeaders.getSetCookie === 'function') {
      list = anyHeaders.getSetCookie()
    } else {
      const raw = res.headers.get('set-cookie')
      if (raw) {
        list = raw.split(/,(?=\s*[^;=]+=[^;]+)/)
      }
    }
    for (const entry of list) {
      const part = entry.split(';')[0]
      const eq = part.indexOf('=')
      if (eq > 0) {
        const k = part.slice(0, eq).trim()
        const v = part.slice(eq + 1).trim()
        if (k) this.cookieJar.set(k, v)
      }
    }
  }

  private cookieHeader(): string | undefined {
    if (!this.cookieJar.size) return undefined
    return [...this.cookieJar.entries()].map(([k, v]) => `${k}=${v}`).join('; ')
  }

  importCookies(cookies: Array<{ name: string; value: string }>): void {
    for (const c of cookies) {
      if (c.name) this.cookieJar.set(c.name, c.value)
    }
  }

  private assertNotChallenge(status: number, text: string, path: string): void {
    if (isShopApiChallengeResponse(status, text)) {
      throw new AppError('NEED_BROWSER', 'shop challenge / WAF intercepted request', {
        path,
        status,
        platformId: this.profile.id,
        snippet: text.slice(0, 180)
      })
    }
  }

  private parseShopData<T>(path: string, status: number, text: string): T {
    if (!text.trim()) {
      throw new AppError('NETWORK', 'shop empty response body', {
        path,
        status,
        platformId: this.profile.id
      })
    }
    this.assertNotChallenge(status, text, path)
    if (status === 0) {
      throw new AppError('NETWORK', `shop page fetch failed: ${text.slice(0, 120)}`, {
        path,
        platformId: this.profile.id
      })
    }
    if (status < 200 || status >= 300) {
      throw new AppError('NETWORK', `shop HTTP ${status}`, {
        path,
        status,
        platformId: this.profile.id,
        snippet: text.slice(0, 200)
      })
    }

    let json: { code?: number; msg?: string; data?: T }
    try {
      json = JSON.parse(text) as { code?: number; msg?: string; data?: T }
    } catch {
      throw new AppError('NETWORK', 'shop non-JSON response body', {
        path,
        platformId: this.profile.id,
        snippet: text.slice(0, 200)
      })
    }
    if (json.code !== 1) {
      throw new AppError('NETWORK', json.msg || `shop code=${json.code}`, {
        path,
        code: json.code,
        platformId: this.profile.id
      })
    }
    return json.data as T
  }

  private async postJsonViaPage<T>(
    path: string,
    body: Record<string, unknown>
  ): Promise<T> {
    if (!this.pageSession?.isOpen) {
      throw new AppError('INTERNAL', 'page session missing')
    }
    await this.waitTurn()
    this.throwIfAborted()
    const { status, text } = await this.pageSession.postJson(path, body, this.visitorId)
    this.throwIfAborted()
    return this.parseShopData<T>(path, status, text)
  }

  private async postJsonViaMainFetch<T>(
    path: string,
    body: Record<string, unknown>,
    token: string
  ): Promise<T> {
    await this.waitTurn()
    this.throwIfAborted()
    const url = `${this.profile.baseUrl}${path}`
    const headers = browserCorsApiHeaders({
      userAgent: this.ua,
      origin: this.profile.baseUrl,
      referer: shopRootUrl(this.profile, token),
      visitorId: this.visitorId,
      cookie: this.cookieHeader()
    })

    let res: Response
    try {
      res = await mainFetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body)
      })
    } catch (err) {
      throw new AppError('NETWORK', `shop fetch failed: ${String(err)}`, {
        path,
        platformId: this.profile.id,
        url,
        ...fetchErrorDetails(err)
      })
    }

    this.absorbSetCookie(res)
    const text = await res.text()
    return this.parseShopData<T>(path, res.status, text)
  }

  private async postJson<T>(
    path: string,
    body: Record<string, unknown>,
    token: string
  ): Promise<T> {
    if (this.usePageFetch && this.pageSession?.isOpen) {
      return await this.postJsonViaPage<T>(path, body)
    }
    return await this.postJsonViaMainFetch<T>(path, body, token)
  }

  private async openShopTab(token: string): Promise<void> {
    this.throwIfAborted()
    const shopUrl = shopRootUrl(this.profile, token)
    if (!this.pageSession) this.pageSession = new ShopPageSession()
    let cleared: boolean
    let mode: 'auto' | 'system_browser'
    try {
      ;({ cleared, mode } = await this.pageSession.open({
        shopUrl,
        userAgent: this.ua,
        openSystemBrowserOnWaf: this.openSystemBrowserOnWaf,
        signal: this.signal
      }))
    } catch (err) {
      if (
        this.signal?.aborted ||
        (err instanceof Error && err.name === 'AbortError')
      ) {
        throw new AppError('CANCELLED', 'shop scrape cancelled', {
          platformId: this.profile.id
        })
      }
      throw err
    }
    this.throwIfAborted()
    const cookies = await this.pageSession.readCookies()
    this.importCookies(cookies)
    this.usePageFetch = this.pageSession.isOpen
    log.info('shop tab opened for API', {
      platformId: this.profile.id,
      cleared,
      mode,
      usePageFetch: this.usePageFetch,
      cookies: cookies.map((c) => c.name)
    })
    if (!cleared) {
      // Queue will scrape other shops first, then retry once
      throw new AppError('NEED_BROWSER', 'shop WAF — deferred for later retry', {
        platformId: this.profile.id,
        mode,
        shopUrl,
        deferrable: true
      })
    }
    if (!this.usePageFetch) {
      throw new AppError('NEED_BROWSER', 'could not open shop page session', {
        platformId: this.profile.id,
        shopUrl,
        deferrable: true
      })
    }
  }

  /**
   * Always open a real shop tab first (browser path that does not trip WAF),
   * then use in-page fetch for APIs. Falls back to mainFetch-only if Electron missing.
   */
  async warmup(token: string): Promise<void> {
    try {
      await this.openShopTab(token)
      return
    } catch (err) {
      if (err instanceof AppError && err.code === 'CANCELLED') throw err
      log.warn('browser session warmup failed; trying mainFetch', {
        err: String(err),
        platformId: this.profile.id
      })
    }

    // Fallback (vitest / headless without window)
    await this.waitTurn()
    try {
      this.throwIfAborted()
      const shopUrl = shopRootUrl(this.profile, token)
      const res = await mainFetch(shopUrl, {
        headers: browserDocumentHeaders({
          userAgent: this.ua,
          visitorId: this.visitorId,
          cookie: this.cookieHeader()
        })
      })
      this.absorbSetCookie(res)
      const text = await res.text()
      if (!text.trim()) {
        throw new AppError('NETWORK', 'shop empty response during warmup', {
          status: res.status,
          platformId: this.profile.id
        })
      }
      if (isShopApiChallengeResponse(res.status, text)) {
        throw new AppError('NEED_BROWSER', 'shop challenge during warmup', {
          status: res.status,
          platformId: this.profile.id
        })
      }
      log.info('warmup ok (mainFetch)', {
        platformId: this.profile.id,
        status: res.status,
        cookies: [...this.cookieJar.keys()]
      })
    } catch (err) {
      if (err instanceof AppError && (err.code === 'NEED_BROWSER' || err.code === 'NETWORK')) {
        throw err
      }
      log.warn('warmup failed (continuing)', { ...fetchErrorDetails(err) })
    }
  }

  async shopInfo(token: string): Promise<ShopApiShopInfo> {
    const endpoints = resolveShopApiEndpoints(this.profile)
    const data = await this.postJson<Record<string, unknown>>(
      endpoints.info,
      { token, category_key: null },
      token
    )
    const sort = Array.isArray(data.goods_type_sort)
      ? (data.goods_type_sort as string[])
      : [...this.profile.defaultGoodsTypes]
    return {
      token: String(data.token ?? token),
      nickname: data.nickname != null ? String(data.nickname) : null,
      goods_count: Number(data.goods_count ?? 0),
      goods_type_sort: sort,
      link: data.link != null ? String(data.link) : null
    }
  }

  async goodsList(params: {
    token: string
    goodsType: string
    current: number
    pageSize?: number
    categoryId?: number
    keywords?: string
  }): Promise<{ list: ShopApiGoodsItem[]; total?: number }> {
    const endpoints = resolveShopApiEndpoints(this.profile)
    const pageSize = Math.min(
      params.pageSize ?? SHOP_API_LIMITS.defaultPageSize,
      SHOP_API_LIMITS.maxPageSize
    )
    const data = await this.postJson<Record<string, unknown> | ShopApiGoodsItem[]>(
      endpoints.goodsList,
      {
        token: params.token,
        keywords: params.keywords ?? '',
        category_id: params.categoryId ?? 0,
        goods_type: params.goodsType,
        current: params.current,
        pageSize
      },
      params.token
    )

    if (Array.isArray(data)) {
      return { list: data as ShopApiGoodsItem[] }
    }
    const list = (data.list || data.rows || data.data || []) as ShopApiGoodsItem[]
    const total = data.total != null ? Number(data.total) : undefined
    return { list: Array.isArray(list) ? list : [], total }
  }
}
