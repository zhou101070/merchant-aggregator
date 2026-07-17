import { describe, expect, it } from 'vitest'
import { isLdxpChallengeResponse } from '../client'
import { isShopApiChallengeResponse } from '../../shopapi/challenge'

describe('isShopApiChallengeResponse / isLdxpChallengeResponse', () => {
  it('does not flag normal shopApi JSON even if body mentions 验证', () => {
    const body = JSON.stringify({
      code: 1,
      msg: 'success',
      data: {
        list: [{ goods_key: 'x', name: '接码/验证 服务', description: '短信验证码' }]
      }
    })
    expect(isShopApiChallengeResponse(200, body)).toBe(false)
    expect(isLdxpChallengeResponse(200, body)).toBe(false)
  })

  it('does not flag normal SPA html shell', () => {
    const html = `<!DOCTYPE html><html lang="zh"><head><title>链动小铺</title></head><body><div id="app"></div></body></html>`
    expect(isShopApiChallengeResponse(200, html)).toBe(false)
  })

  it('flags 403/405', () => {
    expect(isShopApiChallengeResponse(403, 'forbidden')).toBe(true)
    expect(isShopApiChallengeResponse(405, 'nope')).toBe(true)
  })

  it('flags real challenge html', () => {
    const html = `<!DOCTYPE html><html><script>var arg1='x'; /* acw_sc__v2 */</script><body>请完成验证</body></html>`
    expect(isShopApiChallengeResponse(200, html)).toBe(true)
  })

  it('does not treat empty body as challenge (NETWORK at client layer)', () => {
    expect(isShopApiChallengeResponse(200, '')).toBe(false)
  })
})
