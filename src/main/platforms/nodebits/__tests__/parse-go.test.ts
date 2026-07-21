import { describe, expect, it } from 'vitest'
import { nodebitsShopGoUrl, parseNodebitsGoTargetHtml } from '../parse-go'

describe('nodebitsShopGoUrl', () => {
  it('builds /go?type=shop&id=', () => {
    expect(nodebitsShopGoUrl('https://www.nodebits.xyz', 'abc-123')).toBe(
      'https://www.nodebits.xyz/go?type=shop&id=abc-123'
    )
  })
})

describe('parseNodebitsGoTargetHtml', () => {
  it('extracts href from 不想等待,直接前往 anchor', () => {
    const html = `
      <html><body>
        <h1>Antipro</h1>
        <p>catfk.com</p>
        <p>正在安全跳转...</p>
        <a href="https://www.catfk.com/shop/TOKEN99">不想等待,直接前往</a>
      </body></html>
    `
    expect(parseNodebitsGoTargetHtml(html)).toBe('https://www.catfk.com/shop/TOKEN99')
  })

  it('extracts when href precedes button text', () => {
    const html = `
      <a class="btn" href="https://pay.ldxp.cn/shop/PAXOVOVJ">
        <span>不想等待</span><span>直接前往</span>
      </a>
    `
    expect(parseNodebitsGoTargetHtml(html)).toBe('https://pay.ldxp.cn/shop/PAXOVOVJ')
  })

  it('ignores nodebits self links and cloudflare challenge shell', () => {
    const cf = `<html><title>Just a moment...</title>
      <a href="https://www.cloudflare.com/">Cloudflare</a>
      <p>正在进行安全验证</p></html>`
    expect(parseNodebitsGoTargetHtml(cf)).toBeNull()

    const selfOnly = `
      <a href="https://www.nodebits.xyz/">返回首页</a>
      <a href="/shops">店铺</a>
      <p>安全跳转</p>
    `
    expect(parseNodebitsGoTargetHtml(selfOnly)).toBeNull()
  })

  it('accepts meta refresh to external shop', () => {
    const html = `
      <meta http-equiv="refresh" content="3;url=https://example-shop.test/store/1">
      <p>正在安全跳转</p>
    `
    expect(parseNodebitsGoTargetHtml(html)).toBe('https://example-shop.test/store/1')
  })
})
