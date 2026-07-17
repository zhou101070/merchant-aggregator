/**
 * Detect real ESA/WAF challenge pages — NOT product copy that contains 验证/接码.
 * Legitimate JSON API bodies must never become NEED_BROWSER.
 * Shared across all shopApi-family sites.
 */
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

  return /acw_sc__v2|aliyun_waf|x5secdata|window\._config_|var\s+arg1\s*=|captcha-box|geetest|滑块验证|安全验证|请完成验证/i.test(
    trimmed
  )
}

/** @deprecated use isShopApiChallengeResponse */
export const isLdxpChallengeResponse = isShopApiChallengeResponse
