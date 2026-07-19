import { AppError } from '@shared/types/errors'
import { SHOP_API_LIMITS } from '@shared/constants'
import {
  DUJIAO_PLATFORM_ID,
  YICIYUAN_PLATFORM_ID,
  identifyShopPlatform
} from '@shared/platforms/identify'
import { SHOP_PROFILES } from '@shared/platforms/shop-profiles'
import { findProfileById } from '@shared/platforms/shop-types'
import type { RefreshStockRequest, RefreshStockResult, ShopProduct } from '@shared/types/product'
import type { Repositories } from '../db/repositories'
import { resolveDujiaoBaseUrl } from '../platforms/dujiao/client'
import { fetchDujiaoProductRows } from '../platforms/dujiao/scraper'
import { resolveYiciyuanBaseUrl } from '../platforms/yiciyuan/client'
import { fetchYiciyuanProductRow } from '../platforms/yiciyuan/scraper'
import { ShopApiClient } from '../platforms/shopapi/client'
import { normalizeGoods } from '../platforms/shopapi/scraper'
import { createLogger } from '../utils/logger'

const log = createLogger('product-stock')

function productIdFromHit(id: string): string {
  return id.startsWith('shop:') ? id.slice(5) : id
}

/**
 * Approximate single-product stock refresh via goodsList keywords + goods_key match.
 * goodsInfo has no stock; keywords=goods_key does not work (live probe).
 * Dujiao: GET /api/v1/public/products/:slug.
 * Yiciyuan: full catalog scan (no single-item public API).
 */
export class ProductStockService {
  constructor(private readonly repos: Repositories) {}

  async refresh(req: RefreshStockRequest): Promise<RefreshStockResult> {
    const settings = this.repos.settings.get()

    const productId = productIdFromHit(req.productId)
    const local = this.repos.shopProducts.getById(productId)
    if (!local) {
      throw new AppError('NOT_FOUND', 'product not in local db', { productId })
    }

    const platformId = local.source
    const token = local.sourceShopToken
    const identity = identifyShopPlatform({
      shopPlatform: platformId,
      shopToken: token
    })

    if (identity.scrapeStrategy === 'dujiao' || platformId === DUJIAO_PLATFORM_ID) {
      return this.refreshDujiao(local, settings.shopMinIntervalMs ?? settings.ldxpMinIntervalMs)
    }

    if (
      identity.scrapeStrategy === 'yiciyuan' ||
      platformId === YICIYUAN_PLATFORM_ID ||
      platformId === 'kami'
    ) {
      return this.refreshYiciyuan(local, settings.shopMinIntervalMs ?? settings.ldxpMinIntervalMs)
    }

    if (identity.scrapeStrategy !== 'shopapi' || !identity.platformId) {
      throw new AppError('NOT_FOUND', identity.reason || `unknown platform ${platformId}`, {
        platformId,
        family: identity.family
      })
    }
    const profile = findProfileById(identity.platformId, SHOP_PROFILES)
    if (!profile) {
      throw new AppError('NOT_FOUND', `unknown platform ${platformId}`, { platformId })
    }
    if (!profile.enabled) {
      throw new AppError('PAUSED', `platform ${platformId} scrape disabled`, { platformId })
    }

    const goodsKey = local.sourceGoodsKey
    const title = local.title
    const goodsType = local.goodsType
    const minIntervalMs = settings.shopMinIntervalMs ?? settings.ldxpMinIntervalMs

    const client = new ShopApiClient(profile, { minIntervalMs })
    await client.warmup(token)

    const item = await this.findGoodsItem(client, {
      token,
      goodsKey,
      title,
      goodsType,
      defaultTypes: [...profile.defaultGoodsTypes]
    })

    if (!item) {
      log.info('stock refresh miss', { productId, token, goodsKey })
      return { status: 'not_found', productId }
    }

    const stock =
      typeof item.extend?.stock_count === 'number' && Number.isFinite(item.extend.stock_count)
        ? item.extend.stock_count
        : null

    if (typeof stock !== 'number' || stock <= 0) {
      this.repos.shopProducts.deleteById(productId)
      log.info('stock refresh removed oos', { productId, stock })
      return { status: 'removed', productId, stock }
    }

    const row = normalizeGoods(item, {
      profile,
      token,
      merchantId: local.merchantId,
      shopName: local.shopName,
      goodsType: item.goods_type || goodsType || profile.defaultGoodsTypes[0] || 'card',
      fetchedAt: new Date().toISOString()
    })
    if (!row) {
      this.repos.shopProducts.deleteById(productId)
      return { status: 'removed', productId, stock }
    }

    this.repos.shopProducts.upsertMany([row])
    const product = this.repos.shopProducts.getById(row.id)
    log.info('stock refresh updated', { productId: row.id, stock })
    return {
      status: 'updated',
      productId: row.id,
      stock,
      product: product as ShopProduct
    }
  }

  private async refreshDujiao(
    local: ShopProduct,
    minIntervalMs: number
  ): Promise<RefreshStockResult> {
    const productId = local.id
    const host = local.sourceShopToken
    const merchant = local.merchantId ? this.repos.merchants.getById(local.merchantId) : null
    const baseUrl = resolveDujiaoBaseUrl({
      host,
      shopUrl: merchant?.shopUrl,
      entryUrl: merchant?.entryUrl
    })

    const rows = await fetchDujiaoProductRows({
      host,
      baseUrl,
      goodsKey: local.sourceGoodsKey,
      merchantId: local.merchantId,
      shopName: local.shopName,
      minIntervalMs
    })

    const row = rows[0]
    if (!row) {
      this.repos.shopProducts.deleteById(productId)
      log.info('dujiao stock refresh removed oos/missing', { productId })
      return { status: 'removed', productId, stock: 0 }
    }

    this.repos.shopProducts.upsertMany([row])
    const product = this.repos.shopProducts.getById(row.id)
    log.info('dujiao stock refresh updated', { productId: row.id, stock: row.stock })
    return {
      status: 'updated',
      productId: row.id,
      stock: row.stock ?? 0,
      product: product as ShopProduct
    }
  }

  private async refreshYiciyuan(
    local: ShopProduct,
    minIntervalMs: number
  ): Promise<RefreshStockResult> {
    const productId = local.id
    const host = local.sourceShopToken
    const merchant = local.merchantId ? this.repos.merchants.getById(local.merchantId) : null
    const baseUrl = resolveYiciyuanBaseUrl({
      host,
      shopUrl: merchant?.shopUrl,
      entryUrl: merchant?.entryUrl
    })

    const row = await fetchYiciyuanProductRow({
      host,
      baseUrl,
      goodsKey: local.sourceGoodsKey,
      merchantId: local.merchantId,
      shopName: local.shopName,
      minIntervalMs
    })

    if (!row) {
      this.repos.shopProducts.deleteById(productId)
      log.info('yiciyuan stock refresh removed oos/missing', { productId })
      return { status: 'removed', productId, stock: 0 }
    }

    this.repos.shopProducts.upsertMany([row])
    const product = this.repos.shopProducts.getById(row.id)
    log.info('yiciyuan stock refresh updated', { productId: row.id, stock: row.stock })
    return {
      status: 'updated',
      productId: row.id,
      stock: row.stock ?? 0,
      product: product as ShopProduct
    }
  }

  private async findGoodsItem(
    client: ShopApiClient,
    opts: {
      token: string
      goodsKey: string
      title: string
      goodsType: string | null
      defaultTypes: string[]
    }
  ): Promise<import('../platforms/shopapi/client').ShopApiGoodsItem | null> {
    const types = opts.goodsType
      ? [opts.goodsType, ...opts.defaultTypes.filter((t) => t !== opts.goodsType)]
      : opts.defaultTypes

    // 1) keywords = full title (probe: unique title → total=1)
    if (opts.title.trim()) {
      for (const goodsType of types) {
        const hit = await this.scanList(client, {
          token: opts.token,
          goodsType,
          goodsKey: opts.goodsKey,
          keywords: opts.title.trim(),
          maxPages: 3
        })
        if (hit) return hit
      }
    }

    // 2) fallback: paginate known goods_type without keywords (bounded)
    if (opts.goodsType) {
      return this.scanList(client, {
        token: opts.token,
        goodsType: opts.goodsType,
        goodsKey: opts.goodsKey,
        keywords: '',
        maxPages: 15
      })
    }

    return null
  }

  private async scanList(
    client: ShopApiClient,
    opts: {
      token: string
      goodsType: string
      goodsKey: string
      keywords: string
      maxPages: number
    }
  ): Promise<import('../platforms/shopapi/client').ShopApiGoodsItem | null> {
    const pageSize = SHOP_API_LIMITS.defaultPageSize
    for (let page = 1; page <= opts.maxPages; page += 1) {
      const { list } = await client.goodsList({
        token: opts.token,
        goodsType: opts.goodsType,
        current: page,
        pageSize,
        keywords: opts.keywords
      })
      if (!list.length) break
      const hit = list.find((g) => g.goods_key === opts.goodsKey)
      if (hit) return hit
      if (list.length < pageSize) break
    }
    return null
  }
}
