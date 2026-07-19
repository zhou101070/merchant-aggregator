import { describe, expect, it } from 'vitest'
import { isOnTargetShopUrl, isWafChallengeCleared } from '../waf-challenge-window'

describe('isWafChallengeCleared', () => {
  it('accepts storefront chrome', () => {
    const html = `<!doctype html><html><body>
      <div>商品列表</div><div>店铺公告</div><div>库存充足</div>
    </body></html>`
    expect(isWafChallengeCleared(200, html)).toBe(true)
  })

  it('rejects bare WAF challenge', () => {
    const html = `<!doctype html><html><body>
      <div class="captcha-box">请完成安全验证</div>
      <script>var arg1='x'</script>
    </body></html>`
    expect(isWafChallengeCleared(200, html)).toBe(false)
  })

  it('rejects 403 challenge status', () => {
    expect(isWafChallengeCleared(403, '<html>denied</html>')).toBe(false)
  })

  it('accepts large non-challenge HTML after navigation', () => {
    const body = 'x'.repeat(2000)
    const html = `<!doctype html><html><body><div id="app">${body}</div></body></html>`
    expect(isWafChallengeCleared(200, html)).toBe(true)
  })
})

describe('isOnTargetShopUrl', () => {
  const shop = 'https://ldxp.example/s/abc123'

  it('accepts exact shop URL', () => {
    expect(isOnTargetShopUrl(shop, shop)).toBe(true)
    expect(isOnTargetShopUrl(`${shop}/`, shop)).toBe(true)
    expect(isOnTargetShopUrl(`${shop}?x=1`, shop)).toBe(true)
  })

  it('accepts path under shop prefix', () => {
    expect(isOnTargetShopUrl(`${shop}/item/1`, shop)).toBe(true)
  })

  it('rejects intermediate WAF / other paths', () => {
    expect(isOnTargetShopUrl('https://cdn.example/challenge', shop)).toBe(false)
    expect(isOnTargetShopUrl('https://ldxp.example/other', shop)).toBe(false)
    expect(isOnTargetShopUrl('https://ldxp.example/s/other', shop)).toBe(false)
  })
})
