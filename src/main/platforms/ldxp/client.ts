/**
 * Compatibility re-exports — implementation lives in shopapi/.
 * Prefer importing from platforms/shopapi for new code.
 */
export {
  createVisitorId,
  ShopApiClient as LdxpClient,
  type ShopApiGoodsItem as LdxpGoodsItem,
  type ShopApiShopInfo as LdxpShopInfo
} from '../shopapi/client'
export { isShopApiChallengeResponse as isLdxpChallengeResponse } from '../shopapi/challenge'
