import { randomBytes } from 'node:crypto'
import { AppError } from '@shared/types/errors'
import type { ShopSiteProfile } from '@shared/platforms/shop-types'
import { itemPageUrl, resolveShopApiEndpoints, shopRootUrl } from '@shared/platforms/shop-types'
import { SHOP_API_LIMITS } from '@shared/constants'
import { createLogger } from '../../utils/logger'
import { fetchErrorDetails, mainFetch } from '../../utils/main-fetch'
import { getHostLimiter, hostKey } from '../../services/rate-limiter'
import {
  browserCorsApiHeaders,
  browserDocumentHeaders,
  resolveRequestUserAgent
} from '../../utils/request-headers'
import { isShopApiChallengeResponse } from './challenge'

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
  user?: { token?: string; nickname?: string; link?: string | null } | null
}

/** Response of /shopApi/Shop/goodsInfo — used to map item URL → shop root. */
export interface ShopApiGoodsInfo {
  goods_key: string
  name: string | null
  shopToken: string
  shopUrl: string
  nickname: string | null
}

/**
 * Parameterized shopApi-family HTTP client.
 * All host/path/Origin/Referer come from ShopSiteProfile — no host if-branches.
 */
export class ShopApiClient {
  private readonly profile: ShopSiteProfile
  private readonly visitorId: string
  private readonly cookieJar = new Map<string, string>()
  private readonly ua: string
  private readonly minIntervalMs: number
  private readonly host: string

  constructor(
    profile: ShopSiteProfile,
    options?: { visitorId?: string; userAgent?: string; minIntervalMs?: number }
  ) {
    this.profile = profile
    this.visitorId = options?.visitorId ?? createVisitorId()
    this.ua = resolveRequestUserAgent(options?.userAgent)
    this.minIntervalMs = options?.minIntervalMs ?? profile.defaultMinIntervalMs
    this.host = hostKey(profile.baseUrl)
  }

  /** Shared process-wide host lane — different hosts do not block each other. */
  private async throttle(signal?: AbortSignal): Promise<void> {
    await getHostLimiter(this.minIntervalMs).waitTurn(this.host, signal)
  }

  get baseUrl(): string {
    return this.profile.baseUrl
  }

  get platformId(): string {
    return this.profile.id
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

  private async postJson<T>(
    path: string,
    body: Record<string, unknown>,
    referer: string,
    signal?: AbortSignal
  ): Promise<T> {
    await this.throttle(signal)
    const url = `${this.profile.baseUrl}${path}`
    const headers = browserCorsApiHeaders({
      userAgent: this.ua,
      origin: this.profile.baseUrl,
      referer,
      visitorId: this.visitorId,
      cookie: this.cookieHeader()
    })

    let res: Response
    try {
      res = await mainFetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal
      })
    } catch (err) {
      if (err instanceof Error && (err.name === 'AbortError' || /aborted/i.test(err.message))) {
        throw new AppError('CANCELLED', 'shop request cancelled', {
          path,
          platformId: this.profile.id
        })
      }
      throw new AppError('NETWORK', `shop fetch failed: ${String(err)}`, {
        path,
        platformId: this.profile.id,
        url,
        ...fetchErrorDetails(err)
      })
    }

    this.absorbSetCookie(res)
    const text = await res.text()

    // Empty body after TLS (seen on some white-labels under WAF) → NETWORK
    if (!text.trim()) {
      throw new AppError('NETWORK', 'shop empty response body', {
        path,
        status: res.status,
        platformId: this.profile.id
      })
    }

    this.assertNotChallenge(res.status, text, path)

    if (!res.ok) {
      throw new AppError('NETWORK', `shop HTTP ${res.status}`, {
        path,
        status: res.status,
        platformId: this.profile.id,
        snippet: text.slice(0, 200)
      })
    }

    let json: { code?: number; msg?: string; data?: T }
    try {
      json = JSON.parse(text) as { code?: number; msg?: string; data?: T }
    } catch {
      // Design R1: empty/non-JSON body treated as network/WAF class, not schema rewrite
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

  private postJsonForShopToken<T>(
    path: string,
    body: Record<string, unknown>,
    token: string,
    signal?: AbortSignal
  ): Promise<T> {
    return this.postJson(path, body, shopRootUrl(this.profile, token), signal)
  }

  async warmup(token: string, signal?: AbortSignal): Promise<void> {
    await this.throttle(signal)
    try {
      const res = await mainFetch(shopRootUrl(this.profile, token), {
        headers: browserDocumentHeaders({
          userAgent: this.ua,
          visitorId: this.visitorId
        }),
        signal
      })
      this.absorbSetCookie(res)
      const text = await res.text()
      if (!text.trim()) {
        log.warn('warmup empty body', { platformId: this.profile.id, status: res.status })
        throw new AppError('NETWORK', 'shop empty response during warmup', {
          status: res.status,
          platformId: this.profile.id
        })
      }
      if (isShopApiChallengeResponse(res.status, text)) {
        log.warn('warmup hit challenge page', {
          platformId: this.profile.id,
          status: res.status,
          cookies: [...this.cookieJar.keys()]
        })
        throw new AppError('NEED_BROWSER', 'shop challenge during warmup', {
          status: res.status,
          platformId: this.profile.id
        })
      }
      log.info('warmup ok', {
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
    const data = await this.postJsonForShopToken<Record<string, unknown>>(
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

  /**
   * Item page API: goods_key → owning shop token + shop root URL.
   * Referer must be the item page (not /shop/:token).
   */
  async goodsInfo(goodsKey: string): Promise<ShopApiGoodsInfo> {
    const key = goodsKey.trim()
    if (!key) {
      throw new AppError('SCHEMA_VALIDATION', 'goodsInfo requires goods_key', {
        platformId: this.profile.id
      })
    }
    const endpoints = resolveShopApiEndpoints(this.profile)
    const data = await this.postJson<Record<string, unknown>>(
      endpoints.goodsInfo,
      { goods_key: key },
      itemPageUrl(this.profile, key)
    )
    const user =
      data.user && typeof data.user === 'object' && !Array.isArray(data.user)
        ? (data.user as Record<string, unknown>)
        : null
    const tokenRaw = user?.token != null ? String(user.token).trim() : ''
    if (!tokenRaw) {
      throw new AppError('SCHEMA_VALIDATION', 'goodsInfo missing user.token', {
        platformId: this.profile.id,
        goodsKey: key
      })
    }
    const linkRaw = user?.link != null ? String(user.link).trim() : ''
    const shopUrl = linkRaw || shopRootUrl(this.profile, tokenRaw)
    return {
      goods_key: data.goods_key != null ? String(data.goods_key) : key,
      name: data.name != null ? String(data.name) : null,
      shopToken: tokenRaw,
      shopUrl,
      nickname: user?.nickname != null ? String(user.nickname) : null
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
    const data = await this.postJsonForShopToken<Record<string, unknown> | ShopApiGoodsItem[]>(
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
