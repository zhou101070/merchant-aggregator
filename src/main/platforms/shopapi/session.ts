/**
 * Deprecated: product sync uses simulated browser HTTP (ShopApiClient + mainFetch).
 * Pool / page-session path is no longer used; methods throw if called.
 */
import { AppError } from '@shared/types/errors'
import type { ShopSiteProfile } from '@shared/platforms/shop-types'
import type { NormalizedShopProductRow } from '../../db/repositories/shop-products-repo'
import type { ShopApiClient } from './client'

export class ShopApiScrapeSession {
  readonly client: ShopApiClient
  readonly goodsTypes: string[]
  readonly shopName: string | null

  private constructor(client: ShopApiClient, goodsTypes: string[], shopName: string | null) {
    this.client = client
    this.goodsTypes = goodsTypes
    this.shopName = shopName
  }

  static async open(_opts: {
    profile: ShopSiteProfile
    token: string
    merchantId?: string | null
    minIntervalMs?: number
    signal?: AbortSignal
    openSystemBrowserOnWaf?: boolean
    seedCookies?: Array<{ name: string; value: string }>
    requestBudget?: { hold: <T>(fn: () => Promise<T>) => Promise<T> }
  }): Promise<ShopApiScrapeSession> {
    throw new AppError(
      'INTERNAL',
      'ShopApiScrapeSession is disabled; product sync uses simulated browser HTTP (mainFetch)'
    )
  }

  async scrapeGoodsType(_goodsType: string): Promise<NormalizedShopProductRow[]> {
    throw new AppError('INTERNAL', 'ShopApiScrapeSession is disabled')
  }

  async dispose(): Promise<void> {
    /* no-op */
  }
}
