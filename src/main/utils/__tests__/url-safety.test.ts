import { describe, expect, it } from 'vitest'
import { evaluateOpenExternal } from '../url-safety'
import { DEFAULT_APP_SETTINGS } from '@shared/constants'

describe('evaluateOpenExternal', () => {
  const settings = DEFAULT_APP_SETTINGS

  it('allows allowlist hosts', () => {
    expect(evaluateOpenExternal('https://pay.ldxp.cn/shop/ABC', settings).action).toBe('allow')
  })

  it('requires confirm for unknown hosts by default', () => {
    const d = evaluateOpenExternal('https://evil.example/x', settings)
    expect(d.action).toBe('confirm')
  })

  it('rejects non-http protocols', () => {
    expect(() => evaluateOpenExternal('javascript:alert(1)', settings)).toThrow()
  })
})
