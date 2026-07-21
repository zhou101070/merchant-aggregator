import { describe, expect, it } from 'vitest'
import {
  familyHintFromUrls,
  hasDujiaoUrlHint,
  hasYiciyuanUrlHint
} from '../url-hints'

describe('url-hints', () => {
  it('detects yiciyuan item path', () => {
    expect(hasYiciyuanUrlHint(null, 'https://wiki123.top/item/8')).toBe(true)
    expect(familyHintFromUrls('https://x.com/item/12', null)).toBe('yiciyuan')
  })

  it('detects yiciyuan user paths', () => {
    expect(hasYiciyuanUrlHint('https://a.com/user/authentication/login', null)).toBe(true)
  })

  it('detects dujiao products path', () => {
    expect(hasDujiaoUrlHint('https://flyai.qzz.io/products', null)).toBe(true)
    expect(familyHintFromUrls(null, 'https://x.com/api/v1/public/config')).toBe('dujiao')
  })

  it('ignores bare origin', () => {
    expect(hasYiciyuanUrlHint('https://web3chirou.com/', null)).toBe(false)
    expect(familyHintFromUrls('https://example.com/', null)).toBeNull()
  })
})
