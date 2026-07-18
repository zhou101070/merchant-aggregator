/**
 * Detect real ESA/WAF challenge pages — NOT product copy that contains 验证/接码.
 * Legitimate JSON API bodies must never become NEED_BROWSER.
 * Shared across all shopApi-family sites.
 */

/** ldxp/catfk shop SPA after load — must not be treated as WAF (false positive). */
export function isShopStorefrontHtml(text: string): boolean {
  const t = text ?? ''
  // Visible storefront chrome (from live ldxp UI)
  if (/商品列表|店铺公告|商品分类|卡密\s*\(|库存充足|库存少量|Powered by\s*链动/i.test(t)) {
    return true
  }
  // Hydrated #app with substantial body (SPA shell alone is not enough)
  if (/id=["']app["']/i.test(t) && t.length > 8000 && !isBareWafChallengeHtml(t)) {
    return true
  }
  return false
}

/** Strict WAF markers only (avoid SPA globals like window._config_). */
function isBareWafChallengeHtml(text: string): boolean {
  return /acw_sc__v2|aliyun_waf|x5secdata|captcha-box|geetest|滑块验证|请完成安全验证|var\s+arg1\s*=\s*['"]/i.test(
    text
  )
}

export function isShopApiChallengeResponse(status: number, text: string): boolean {
  if (status === 403 || status === 405 || status === 429) {
    // 429 is rate limit; treat as NETWORK at higher layer
    if (status === 429) return false
    return true
  }

  const trimmed = (text ?? '').trim()
  if (!trimmed) return false

  // JSON success/error from shopApi — never a browser challenge
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      const json = JSON.parse(trimmed) as { code?: unknown }
      if (json && typeof json === 'object' && 'code' in json) return false
    } catch {
      // fall through to HTML heuristics
    }
  }

  const looksHtml = /<!doctype html|<html[\s>]|<\/html>/i.test(trimmed)
  if (!looksHtml) return false

  // Real shop UI beats WAF heuristics (products often contain 验证/接码)
  if (isShopStorefrontHtml(trimmed)) return false

  return isBareWafChallengeHtml(trimmed)
}
