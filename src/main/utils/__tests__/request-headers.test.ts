import { describe, expect, it } from 'vitest'
import {
  browserCorsApiHeaders,
  browserDocumentHeaders,
  browserJsonGetHeaders,
  chromeMajor,
  resolveBrowserPlatform,
  resolveChromeUserAgent,
  resolveRequestUserAgent
} from '../request-headers'

describe('request-headers', () => {
  it('builds Windows Chrome UA from version + platform', () => {
    const ua = resolveChromeUserAgent({ chromeVersion: '131.0.6778.0', platform: 'Windows' })
    expect(ua).toContain('Windows NT 10.0; Win64; x64')
    expect(ua).toContain('Chrome/131.0.6778.0')
    expect(ua).not.toContain('Macintosh')
  })

  it('maps node platforms', () => {
    expect(resolveBrowserPlatform('win32')).toBe('Windows')
    expect(resolveBrowserPlatform('darwin')).toBe('macOS')
    expect(resolveBrowserPlatform('linux')).toBe('Linux')
  })

  it('resolveRequestUserAgent falls back to Chrome when empty or legacy', () => {
    expect(resolveRequestUserAgent('')).toMatch(/Chrome\//)
    expect(resolveRequestUserAgent('  ')).toMatch(/Chrome\//)
    expect(resolveRequestUserAgent(null)).toMatch(/Chrome\//)
    expect(
      resolveRequestUserAgent(
        'MerchantAggregator/1.0 (+personal-research; contact: local-user)'
      )
    ).toMatch(/Chrome\//)
    expect(resolveRequestUserAgent('CustomBot/1.0')).toBe('CustomBot/1.0')
  })

  it('json get headers share base browser fields', () => {
    const ua = resolveChromeUserAgent({ chromeVersion: '120.0.0.0', platform: 'Windows' })
    const h = browserJsonGetHeaders({ userAgent: ua, platform: 'Windows' })
    expect(h.Accept).toContain('application/json')
    expect(h['Accept-Language']).toMatch(/zh-CN/)
    expect(h['Sec-Fetch-Mode']).toBe('cors')
    expect(h['Sec-Fetch-Dest']).toBe('empty')
    expect(h['Sec-Fetch-Site']).toBe('none')
    expect(h['sec-ch-ua-platform']).toBe('"Windows"')
    expect(h['User-Agent']).toBe(ua)
  })

  it('document nav headers look like Chrome navigation', () => {
    const ua = resolveChromeUserAgent({ chromeVersion: '120.0.0.0', platform: 'Windows' })
    const h = browserDocumentHeaders({ userAgent: ua, visitorId: 'abc', platform: 'Windows' })
    expect(h['Sec-Fetch-Mode']).toBe('navigate')
    expect(h['Sec-Fetch-Dest']).toBe('document')
    expect(h['Sec-Fetch-Site']).toBe('none')
    expect(h['Sec-Fetch-User']).toBe('?1')
    expect(h['Upgrade-Insecure-Requests']).toBe('1')
    expect(h['sec-ch-ua-mobile']).toBe('?0')
    expect(h['sec-ch-ua']).toContain(`"Chromium";v="${chromeMajor('120.0.0.0')}"`)
    expect(h.Visitorid).toBe('abc')
  })

  it('cors api headers look like same-origin XHR', () => {
    const ua = resolveChromeUserAgent({ chromeVersion: '120.0.0.0', platform: 'macOS' })
    const h = browserCorsApiHeaders({
      userAgent: ua,
      origin: 'https://pay.ldxp.cn',
      referer: 'https://pay.ldxp.cn/shop/tok',
      visitorId: 'vid',
      cookie: 'a=1',
      platform: 'macOS'
    })
    expect(h['Content-Type']).toBe('application/json')
    expect(h.Origin).toBe('https://pay.ldxp.cn')
    expect(h.Referer).toBe('https://pay.ldxp.cn/shop/tok')
    expect(h['Sec-Fetch-Mode']).toBe('cors')
    expect(h['Sec-Fetch-Site']).toBe('same-origin')
    expect(h['sec-ch-ua-platform']).toBe('"macOS"')
    expect(h.Cookie).toBe('a=1')
    expect(h.Visitorid).toBe('vid')
  })
})
