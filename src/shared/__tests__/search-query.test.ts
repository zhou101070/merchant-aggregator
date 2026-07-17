import { describe, expect, it } from 'vitest'
import { escapeLike, likeContains, tokenizeQuery } from '../lib/search-query'

describe('tokenizeQuery', () => {
  it('splits on whitespace and punctuation', () => {
    expect(tokenizeQuery('Claude Pro / 月卡')).toEqual(['claude', 'pro', '月卡'])
  })

  it('splits Latin↔CJK boundaries without spaces', () => {
    expect(tokenizeQuery('Claude月卡')).toEqual(['claude', '月卡'])
    expect(tokenizeQuery('成品Outlook邮箱')).toEqual(['成品', 'outlook', '邮箱'])
  })

  it('dedupes and normalizes case/fullwidth', () => {
    expect(tokenizeQuery('  Ｃｌａｕｄｅ   Claude  ')).toEqual(['claude'])
  })

  it('drops ultra-short noise but keeps a sole short remnant', () => {
    expect(tokenizeQuery('a b Claude')).toEqual(['claude'])
    expect(tokenizeQuery('AI')).toEqual(['ai'])
  })
})

describe('escapeLike / likeContains', () => {
  it('escapes LIKE metacharacters', () => {
    expect(escapeLike('100%_off\\x')).toBe('100\\%\\_off\\\\x')
    expect(likeContains('a_b')).toBe('%a\\_b%')
  })
})
