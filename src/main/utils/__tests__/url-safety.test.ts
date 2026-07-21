import { describe, expect, it } from 'vitest'
import { evaluateOpenExternal } from '../url-safety'

describe('evaluateOpenExternal', () => {
  it('allows any http(s) host', () => {
    expect(evaluateOpenExternal('https://pay.ldxp.cn/shop/ABC').action).toBe('allow')
    expect(evaluateOpenExternal('https://evil.example/x').action).toBe('allow')
    expect(evaluateOpenExternal('http://example.com').action).toBe('allow')
  })

  it('rejects non-http protocols', () => {
    expect(() => evaluateOpenExternal('javascript:alert(1)')).toThrow()
  })

  it('rejects embedded credentials', () => {
    expect(() => evaluateOpenExternal('https://user:pass@example.com/')).toThrow()
  })
})
